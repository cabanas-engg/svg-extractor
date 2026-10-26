// Local review/correct UI server. No framework: node:http + a static page.
// Every mutation is written straight back to the session file.
//
// The server can start empty: files are then uploaded from the browser into a
// workspace folder (default ./workspace), where each keeps its own session
// file, so an upload can be reopened later from the "recent" list.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseFile } from './parse.js';
import { renderAssetSVG, exportSession, buildExport } from './export.js';
import { svgToPNG } from './svg.js';
import { zip } from './zip.js';
import { DEFAULTS } from './detect.js';
import {
  saveSession, openSession, addManualAsset, mergeAssets, splitAsset, updateAsset, deleteAsset, redetectPage, selectInBox,
  defaultSessionPath,
} from './session.js';

const require = createRequire(import.meta.url);
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PDFJS_DIR = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'legacy', 'build');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
export const MAX_UPLOAD = 300 * 1024 * 1024;
const SOURCE_EXT = /\.(ai|pdf)$/i;

const MAX_SCALE = 10;
const MAX_HISTORY = 100;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Binding to 127.0.0.1 keeps other machines out, but not other web pages open
// in the same browser: they can still send requests to localhost. A Host check
// stops DNS rebinding (a hostile domain re-pointed at 127.0.0.1), and an
// Origin check stops cross-site writes (e.g. a POST to /api/export with an
// arbitrary output folder). Requests without an Origin (curl, tests) are fine.
function checkRequest(req) {
  const host = String(req.headers.host || '');
  if (!LOCAL_HOSTS.has(host.replace(/:\d+$/, ''))) throw httpError(403, `unexpected Host header: ${host}`);
  const origin = req.headers.origin;
  if (req.method !== 'GET' && req.method !== 'HEAD' && origin && origin !== `http://${host}`) {
    throw httpError(403, `cross-origin request from ${origin} refused`);
  }
}

function parseScale(v, fallback = 3) {
  if (v === undefined || v === null || v === '') return fallback;
  const s = Number(v);
  if (!Number.isFinite(s) || s <= 0 || s > MAX_SCALE) throw httpError(400, `scale must be a number between 0 and ${MAX_SCALE}`);
  return s;
}

// ASCII fallback plus the exact UTF-8 name (RFC 6266); a raw non-ASCII or
// quoted name would make Node reject the header.
const attachment = (name) =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

function parseFormats(list) {
  const formats = (Array.isArray(list) ? list : []).map((f) => String(f).trim().toLowerCase()).filter(Boolean);
  if (!formats.length) throw httpError(400, 'pick at least one format');
  for (const f of formats) if (f !== 'svg' && f !== 'png') throw httpError(400, `unknown format ${f}`);
  return formats;
}

function checkBox(b) {
  if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) || b[2] <= b[0] || b[3] <= b[1]) {
    throw httpError(400, 'bbox must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0');
  }
  return b;
}

// Only known, finite, non-negative thresholds; an empty field in the UI would
// otherwise arrive as 0 (or NaN) and silently wreck detection.
function parseOptions(options) {
  const out = {};
  for (const [k, v] of Object.entries(options || {})) {
    if (!(k in DEFAULTS)) throw httpError(400, `unknown option ${k}`);
    const n = Number(v);
    if (v === '' || v === null || !Number.isFinite(n) || n < 0) throw httpError(400, `${k} must be a number ≥ 0`);
    out[k] = n;
  }
  return out;
}

export const exportDirFor = (file) => path.join(path.dirname(path.resolve(file)), path.basename(file).replace(/\.[^.]+$/, '') + '-assets');

/** Open a source file: parse it and load (or create) its session. */
export async function openDocument(file, { sessionPath, redetect, opts } = {}) {
  const parsed = await parseFile(file);
  const { session } = openSession(parsed, { sessionPath: sessionPath || defaultSessionPath(file), redetect, opts });
  return {
    file,
    parsed,
    session,
    sessionPath: sessionPath || defaultSessionPath(file),
    exportDir: exportDirFor(file),
    pages: new Map(parsed.pages.map((p) => [p.page, p])),
  };
}

// Keep the name recognisable but filesystem-safe.
function safeName(name) {
  const base = path.basename(String(name || 'upload')).normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_');
  return (base.replace(/^\.+/, '') || 'upload').slice(0, 120);
}

export function createApp({ workspace, doc: initial = null }) {
  let doc = initial;
  fs.mkdirSync(workspace, { recursive: true });

  const need = () => {
    if (!doc) throw httpError(409, 'no file open: upload one first');
    return doc;
  };
  const save = () => saveSession(doc.sessionPath, doc.session);

  // Undo/redo: whole-session snapshots (a session is a few KB of JSON). History
  // lives in memory for the open document only.
  const history = () => (need().history ||= { undo: [], redo: [] });
  // Run a session edit; on success record the previous state and save, on
  // failure roll back (some edits change the session before they can fail).
  function edit(fn) {
    const before = JSON.stringify(need().session);
    let result;
    try {
      result = fn();
    } catch (e) {
      doc.session = JSON.parse(before);
      throw e;
    }
    if (JSON.stringify(doc.session) !== before) {
      const h = history();
      h.undo.push(before);
      if (h.undo.length > MAX_HISTORY) h.undo.shift();
      h.redo = [];
      save();
    }
    return result;
  }
  function travel(from, to) {
    const h = history();
    if (!h[from].length) throw httpError(409, `nothing to ${from}`);
    h[to].push(JSON.stringify(doc.session));
    doc.session = JSON.parse(h[from].pop());
    save();
  }

  const findAsset = (id) => {
    const a = need().session.assets.find((x) => x.id === id);
    if (!a) throw httpError(404, `no asset ${id}`);
    return a;
  };
  const pageOf = (n) => {
    const p = need().pages.get(Number(n));
    if (!p) throw httpError(404, `page ${n} not loaded`);
    return p;
  };

  function recent() {
    return fs
      .readdirSync(workspace)
      .filter((f) => SOURCE_EXT.test(f))
      .map((f) => {
        const full = path.join(workspace, f);
        const st = fs.statSync(full);
        let assets = null;
        try {
          assets = JSON.parse(fs.readFileSync(defaultSessionPath(full), 'utf8')).assets.length;
        } catch {}
        return { name: f, size: st.size, modified: st.mtimeMs, assets };
      })
      .sort((a, b) => b.modified - a.modified)
      .slice(0, 20);
  }

  const state = () => {
    const base = { workspace, recent: recent(), maxUpload: MAX_UPLOAD };
    if (!doc) return { ...base, empty: true };
    const { session, parsed } = doc;
    return {
      ...base,
      empty: false,
      file: path.basename(doc.file),
      // changes whenever a document is (re)opened; part of thumbnail cache keys
      docId: (doc.id ||= crypto.randomUUID()),
      sessionPath: doc.sessionPath,
      exportDir: doc.exportDir,
      options: session.options,
      pages: session.pages,
      assets: session.assets,
      labels: session.labels,
      warnings: parsed.warnings,
      stale: !!session.stale,
      canUndo: !!doc.history?.undo.length,
      canRedo: !!doc.history?.redo.length,
    };
  };

  async function body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw httpError(400, 'request body is not valid JSON');
    }
  }

  // Stream an upload to a temp file in the workspace, enforcing the size cap.
  async function receive(req) {
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_UPLOAD) throw httpError(413, `file too large (max ${MAX_UPLOAD / 1024 / 1024} MB)`);
    const tmp = path.join(workspace, `.upload-${crypto.randomUUID()}`);
    const out = fs.createWriteStream(tmp);
    const hash = crypto.createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    try {
      for await (const c of req) {
        size += c.length;
        if (size > MAX_UPLOAD) throw httpError(413, `file too large (max ${MAX_UPLOAD / 1024 / 1024} MB)`);
        if (head.length < 1024) head = Buffer.concat([head, c]).subarray(0, 1024);
        hash.update(c);
        if (!out.write(c)) await new Promise((r) => out.once('drain', r));
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    } catch (e) {
      out.destroy();
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    if (!size) {
      fs.rmSync(tmp, { force: true });
      throw httpError(400, 'empty upload');
    }
    if (!head.toString('latin1').includes('%PDF-')) {
      fs.rmSync(tmp, { force: true });
      throw httpError(
        415,
        'This file is not PDF-compatible. Upload a PDF, or an .ai saved with "Create PDF Compatible File" turned on in Illustrator.',
      );
    }
    return { tmp, sha256: hash.digest('hex') };
  }

  // Same name + same bytes → reuse (keeps its session). Same name, different
  // bytes → keep both, suffixing the new one. Returns { dest, created }.
  function place(tmp, sha256, requested) {
    let name = safeName(requested);
    if (!SOURCE_EXT.test(name)) name += '.pdf';
    const stem = name.replace(SOURCE_EXT, ''), ext = name.slice(stem.length);
    for (let i = 1; ; i++) {
      const candidate = i === 1 ? name : `${stem}-${i}${ext}`;
      const dest = path.join(workspace, candidate);
      if (!fs.existsSync(dest)) {
        fs.renameSync(tmp, dest);
        return { dest, created: true };
      }
      const same = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex') === sha256;
      if (same) {
        fs.rmSync(tmp, { force: true });
        return { dest, created: false };
      }
    }
  }

  function send(res, status, data, type = 'application/json', headers = {}) {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  }

  function serveStatic(res, dir, rel) {
    const p = path.normalize(path.join(dir, rel));
    if (!p.startsWith(dir + path.sep) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return send(res, 404, { error: 'not found' });
    send(res, 200, fs.readFileSync(p), MIME[path.extname(p)] || 'application/octet-stream');
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const m = req.method;
    try {
      checkRequest(req);
      if (m === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, UI_DIR, 'index.html');
      if (m === 'GET' && p.startsWith('/ui/')) return serveStatic(res, UI_DIR, p.slice(4));
      if (m === 'GET' && p.startsWith('/pdfjs/')) return serveStatic(res, PDFJS_DIR, p.slice(7));
      if (m === 'GET' && p === '/api/source') return send(res, 200, fs.readFileSync(need().file), 'application/pdf');
      if (m === 'GET' && p === '/api/state') return send(res, 200, state());

      if (m === 'POST' && p === '/api/upload') {
        const { tmp, sha256 } = await receive(req);
        const { dest, created } = place(tmp, sha256, url.searchParams.get('name'));
        try {
          doc = await openDocument(dest);
        } catch (e) {
          // Don't leave an unreadable file in the workspace (and in Recent).
          if (created) for (const f of [dest, defaultSessionPath(dest)]) fs.rmSync(f, { force: true });
          throw httpError(422, `could not read ${path.basename(dest)}: ${e.message}`);
        }
        return send(res, 200, state());
      }
      if (m === 'POST' && p === '/api/open') {
        const { name } = await body(req);
        const file = path.join(workspace, path.basename(String(name)));
        if (!SOURCE_EXT.test(file) || !fs.existsSync(file)) throw httpError(404, `${name} is not in the workspace`);
        doc = await openDocument(file);
        return send(res, 200, state());
      }

      let r;
      if (m === 'GET' && (r = p.match(/^\/api\/assets\/([^/]+)\.(svg|png)$/))) {
        const a = findAsset(decodeURIComponent(r[1]));
        const svg = renderAssetSVG(pageOf(a.page), a, { pad: doc.session.options.pad });
        const headers = url.searchParams.has('download') ? { 'content-disposition': attachment(`${a.name}.${r[2]}`) } : {};
        // ?k= is a content key from the UI (see thumbKey in app.js), so a keyed
        // URL never changes meaning and the browser may keep it.
        if (url.searchParams.has('k')) headers['cache-control'] = 'private, max-age=86400, immutable';
        if (r[2] === 'svg') return send(res, 200, svg, 'image/svg+xml', headers);
        const scale = parseScale(url.searchParams.get('scale'));
        return send(res, 200, svgToPNG(svg, { scale }), 'image/png', headers);
      }

      if (m === 'POST' && p === '/api/preview-box') {
        // How many elements a hand-drawn box would pick up, before committing it.
        const { page, bbox } = await body(req);
        return send(res, 200, { count: selectInBox(pageOf(page), bbox).length });
      }
      if (m === 'POST' && p === '/api/assets') {
        const { page, bbox, name } = await body(req);
        pageOf(page);
        const a = edit(() => addManualAsset(doc.session, page, checkBox(bbox), name));
        return send(res, 200, { asset: a, ...state() });
      }
      if (m === 'PATCH' && (r = p.match(/^\/api\/assets\/([^/]+)$/))) {
        const patch = await body(req);
        if (patch.bbox) checkBox(patch.bbox);
        const id = findAsset(decodeURIComponent(r[1])).id;
        edit(() => updateAsset(doc.session, id, patch));
        return send(res, 200, state());
      }
      if (m === 'DELETE' && (r = p.match(/^\/api\/assets\/([^/]+)$/))) {
        const id = findAsset(decodeURIComponent(r[1])).id;
        edit(() => deleteAsset(doc.session, id));
        return send(res, 200, state());
      }
      if (m === 'POST' && p === '/api/delete') {
        // several at once, so one undo step brings them all back
        const { ids } = await body(req);
        if (!Array.isArray(ids) || !ids.length) throw httpError(400, 'ids must be a non-empty array');
        ids.forEach(findAsset);
        edit(() => ids.forEach((id) => deleteAsset(doc.session, id)));
        return send(res, 200, state());
      }
      if (m === 'POST' && p === '/api/exclude') {
        const { ids, exclude } = await body(req);
        if (!Array.isArray(ids) || !ids.length) throw httpError(400, 'ids must be a non-empty array');
        ids.forEach(findAsset);
        edit(() => ids.forEach((id) => updateAsset(doc.session, id, { exclude: !!exclude })));
        return send(res, 200, state());
      }
      if (m === 'POST' && p === '/api/merge') {
        const { ids } = await body(req);
        if (!Array.isArray(ids) || ids.length < 2) throw httpError(400, 'select at least two assets to merge');
        const first = findAsset(ids[0]);
        const merged = edit(() => mergeAssets(doc.session, pageOf(first.page), ids));
        return send(res, 200, { asset: merged, ...state() });
      }
      if (m === 'POST' && p === '/api/split') {
        const { id, gap } = await body(req);
        const a = findAsset(id);
        const parts = edit(() => splitAsset(doc.session, pageOf(a.page), id, gap));
        if (!parts) throw httpError(422, 'nothing to split: the elements in this box touch each other. Draw boxes by hand instead.');
        return send(res, 200, { parts, ...state() });
      }
      if (m === 'POST' && p === '/api/redetect') {
        const { page, options } = await body(req);
        const opts = parseOptions(options);
        edit(() => redetectPage(doc.session, pageOf(page), opts));
        return send(res, 200, state());
      }
      if (m === 'POST' && p === '/api/undo') {
        travel('undo', 'redo');
        return send(res, 200, state());
      }
      if (m === 'POST' && p === '/api/redo') {
        travel('redo', 'undo');
        return send(res, 200, state());
      }
      if (m === 'POST' && p === '/api/export') {
        const { formats: f = ['svg'], scale, out } = await body(req);
        const formats = parseFormats(f);
        const dir = out ? path.resolve(out) : need().exportDir;
        const manifest = exportSession(need().parsed, doc.session, { out: dir, formats, scale: parseScale(scale) });
        return send(res, 200, { out: dir, count: manifest.assets.filter((a) => !a.skipped).length, manifest });
      }
      if (m === 'GET' && p === '/api/export.zip') {
        const formats = parseFormats((url.searchParams.get('formats') || 'svg').split(','));
        const scale = parseScale(url.searchParams.get('scale'));
        const { files } = buildExport(need().parsed, doc.session, { formats, scale });
        const name = path.basename(doc.file).replace(/\.[^.]+$/, '') + '-assets.zip';
        return send(res, 200, zip(files), 'application/zip', { 'content-disposition': attachment(name) });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      // Plain Errors from session.js are user mistakes (400); a TypeError and
      // friends is a bug here, so log it rather than pass it off as bad input.
      const bug = !e.status && e.constructor !== Error;
      if (bug) console.error(e);
      if (!res.headersSent) send(res, e.status || (bug ? 500 : 400), { error: e.message });
      else res.destroy();
    }
  };
}

export function startServer({ doc = null, workspace, port = 5178, host = '127.0.0.1' }) {
  const server = http.createServer(createApp({ workspace, doc }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const what = doc ? `editing ${doc.file}` : 'no file open — upload one in the browser';
      console.log(`review UI: http://${host}:${port}  (${what}; uploads go to ${workspace}; Ctrl+C to stop)`);
      resolve(server);
    });
  }).catch((e) => {
    if (e.code === 'EADDRINUSE') throw new Error(`port ${port} is already in use (another svg-extractor running?). Try --port ${port + 1}`);
    throw e;
  });
}
