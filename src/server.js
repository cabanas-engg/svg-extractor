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

const httpError = (status, message) => Object.assign(new Error(message), { status });

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
      sessionPath: doc.sessionPath,
      exportDir: doc.exportDir,
      options: session.options,
      pages: session.pages,
      assets: session.assets,
      labels: session.labels,
      warnings: parsed.warnings,
      stale: !!session.stale,
    };
  };

  async function body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
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
  // bytes → keep both, suffixing the new one.
  function place(tmp, sha256, requested) {
    let name = safeName(requested);
    if (!SOURCE_EXT.test(name)) name += '.pdf';
    const stem = name.replace(SOURCE_EXT, ''), ext = name.slice(stem.length);
    for (let i = 1; ; i++) {
      const candidate = i === 1 ? name : `${stem}-${i}${ext}`;
      const dest = path.join(workspace, candidate);
      if (!fs.existsSync(dest)) {
        fs.renameSync(tmp, dest);
        return dest;
      }
      const same = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex') === sha256;
      if (same) {
        fs.rmSync(tmp, { force: true });
        return dest;
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
      if (m === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, UI_DIR, 'index.html');
      if (m === 'GET' && p.startsWith('/ui/')) return serveStatic(res, UI_DIR, p.slice(4));
      if (m === 'GET' && p.startsWith('/pdfjs/')) return serveStatic(res, PDFJS_DIR, p.slice(7));
      if (m === 'GET' && p === '/api/source') return send(res, 200, fs.readFileSync(need().file), 'application/pdf');
      if (m === 'GET' && p === '/api/state') return send(res, 200, state());

      if (m === 'POST' && p === '/api/upload') {
        const { tmp, sha256 } = await receive(req);
        const dest = place(tmp, sha256, url.searchParams.get('name'));
        try {
          doc = await openDocument(dest);
        } catch (e) {
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
        const headers = url.searchParams.has('download') ? { 'content-disposition': `attachment; filename="${a.name}.${r[2]}"` } : {};
        if (r[2] === 'svg') return send(res, 200, svg, 'image/svg+xml', headers);
        const scale = Number(url.searchParams.get('scale')) || 3;
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
        const a = addManualAsset(doc.session, page, bbox, name);
        save();
        return send(res, 200, { asset: a, ...state() });
      }
      if (m === 'PATCH' && (r = p.match(/^\/api\/assets\/([^/]+)$/))) {
        need();
        updateAsset(doc.session, decodeURIComponent(r[1]), await body(req));
        save();
        return send(res, 200, state());
      }
      if (m === 'DELETE' && (r = p.match(/^\/api\/assets\/([^/]+)$/))) {
        need();
        deleteAsset(doc.session, decodeURIComponent(r[1]));
        save();
        return send(res, 200, state());
      }
      if (m === 'POST' && p === '/api/merge') {
        const { ids } = await body(req);
        const first = findAsset(ids[0]);
        const merged = mergeAssets(doc.session, pageOf(first.page), ids);
        save();
        return send(res, 200, { asset: merged, ...state() });
      }
      if (m === 'POST' && p === '/api/split') {
        const { id, gap } = await body(req);
        const a = findAsset(id);
        const parts = splitAsset(doc.session, pageOf(a.page), id, gap);
        if (!parts) throw httpError(422, 'nothing to split: the elements in this box touch each other. Draw boxes by hand instead.');
        save();
        return send(res, 200, { parts, ...state() });
      }
      if (m === 'POST' && p === '/api/redetect') {
        const { page, options } = await body(req);
        redetectPage(doc.session, pageOf(page), options || {});
        save();
        return send(res, 200, state());
      }
      if (m === 'POST' && p === '/api/export') {
        const { formats = ['svg'], scale = 3, out } = await body(req);
        const dir = out ? path.resolve(out) : need().exportDir;
        const manifest = exportSession(need().parsed, doc.session, { out: dir, formats, scale });
        return send(res, 200, { out: dir, count: manifest.assets.filter((a) => !a.skipped).length, manifest });
      }
      if (m === 'GET' && p === '/api/export.zip') {
        const formats = (url.searchParams.get('formats') || 'svg').split(',').filter((f) => f === 'svg' || f === 'png');
        if (!formats.length) throw httpError(400, 'pick at least one format');
        const scale = Number(url.searchParams.get('scale')) || 3;
        const { files } = buildExport(need().parsed, doc.session, { formats, scale });
        const name = path.basename(doc.file).replace(/\.[^.]+$/, '') + '-assets.zip';
        return send(res, 200, zip(files), 'application/zip', { 'content-disposition': `attachment; filename="${name}"` });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, e.status || 400, { error: e.message });
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
  });
}
