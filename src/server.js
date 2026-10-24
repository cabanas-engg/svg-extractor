// Local review/correct UI server. No framework: node:http + a static page.
// Every mutation is written straight back to the session file.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { classify } from './detect.js';
import { renderAssetSVG, exportSession } from './export.js';
import { svgToPNG } from './svg.js';
import {
  saveSession, addManualAsset, mergeAssets, splitAsset, updateAsset, deleteAsset, redetectPage, selectInBox,
} from './session.js';

const require = createRequire(import.meta.url);
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PDFJS_DIR = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'legacy', 'build');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

export function createApp({ file, parsed, session, sessionPath, exportDir }) {
  const pages = new Map(parsed.pages.map((p) => [p.page, p]));
  const rolesCache = new Map();
  const roles = (n) => {
    if (!rolesCache.has(n)) rolesCache.set(n, classify(pages.get(n), session.options));
    return rolesCache.get(n);
  };
  const save = () => saveSession(sessionPath, session);
  const findAsset = (id) => {
    const a = session.assets.find((x) => x.id === id);
    if (!a) throw Object.assign(new Error(`no asset ${id}`), { status: 404 });
    return a;
  };
  const pageOf = (n) => {
    const p = pages.get(Number(n));
    if (!p) throw Object.assign(new Error(`page ${n} not loaded`), { status: 404 });
    return p;
  };

  const state = () => ({
    file: path.basename(file),
    sessionPath,
    exportDir,
    options: session.options,
    pages: session.pages,
    assets: session.assets,
    labels: session.labels,
    warnings: parsed.warnings,
    stale: !!session.stale,
  });

  async function body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  function send(res, status, data, type = 'application/json') {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  }

  function serveStatic(res, dir, rel) {
    const p = path.normalize(path.join(dir, rel));
    if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return send(res, 404, { error: 'not found' });
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
      if (m === 'GET' && p === '/api/source') return send(res, 200, fs.readFileSync(file), 'application/pdf');
      if (m === 'GET' && p === '/api/state') return send(res, 200, state());

      let r;
      if (m === 'GET' && (r = p.match(/^\/api\/assets\/([^/]+)\.(svg|png)$/))) {
        const a = findAsset(decodeURIComponent(r[1]));
        const page = pageOf(a.page);
        const svg = renderAssetSVG(page, a, { pad: session.options.pad, roles: roles(a.page) });
        const dl = url.searchParams.has('download');
        const headers = dl ? { 'content-disposition': `attachment; filename="${a.name}.${r[2]}"` } : {};
        if (r[2] === 'svg') {
          res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store', ...headers });
          return res.end(svg);
        }
        const scale = Number(url.searchParams.get('scale')) || 3;
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', ...headers });
        return res.end(svgToPNG(svg, { scale }));
      }

      if (m === 'POST' && p === '/api/preview-box') {
        // How many elements a hand-drawn box would pick up, before committing it.
        const { page, bbox } = await body(req);
        return send(res, 200, { count: selectInBox(pageOf(page), bbox, { roles: roles(page) }).length });
      }
      if (m === 'POST' && p === '/api/assets') {
        const { page, bbox, name } = await body(req);
        pageOf(page);
        const a = addManualAsset(session, page, bbox, name);
        save();
        return send(res, 200, { asset: a, ...state() });
      }
      if (m === 'PATCH' && (r = p.match(/^\/api\/assets\/([^/]+)$/))) {
        updateAsset(session, decodeURIComponent(r[1]), await body(req));
        save();
        return send(res, 200, state());
      }
      if (m === 'DELETE' && (r = p.match(/^\/api\/assets\/([^/]+)$/))) {
        deleteAsset(session, decodeURIComponent(r[1]));
        save();
        return send(res, 200, state());
      }
      if (m === 'POST' && p === '/api/merge') {
        const { ids } = await body(req);
        const first = findAsset(ids[0]);
        const merged = mergeAssets(session, pageOf(first.page), ids);
        save();
        return send(res, 200, { asset: merged, ...state() });
      }
      if (m === 'POST' && p === '/api/split') {
        const { id, gap } = await body(req);
        const a = findAsset(id);
        const parts = splitAsset(session, pageOf(a.page), id, gap);
        if (!parts) return send(res, 422, { error: 'nothing to split: the elements in this box touch each other. Draw boxes by hand instead.' });
        save();
        return send(res, 200, { parts, ...state() });
      }
      if (m === 'POST' && p === '/api/redetect') {
        const { page, options } = await body(req);
        rolesCache.clear();
        redetectPage(session, pageOf(page), options || {});
        save();
        return send(res, 200, state());
      }
      if (m === 'POST' && p === '/api/export') {
        const { formats = ['svg'], scale = 3, out } = await body(req);
        const dir = out ? path.resolve(out) : exportDir;
        const manifest = exportSession(parsed, session, { out: dir, formats, scale });
        return send(res, 200, { out: dir, count: manifest.assets.filter((a) => !a.skipped).length, manifest });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, e.status || 400, { error: e.message });
    }
  };
}

export function startServer({ file, parsed, session, sessionPath, port = 5178, host = '127.0.0.1' }) {
  const exportDir = path.join(path.dirname(path.resolve(file)), path.basename(file).replace(/\.[^.]+$/, '') + '-assets');
  const server = http.createServer(createApp({ file, parsed, session, sessionPath, exportDir }));
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`review UI: http://${host}:${port}  (session: ${sessionPath}, Ctrl+C to stop)`);
      resolve(server);
    });
  });
}
