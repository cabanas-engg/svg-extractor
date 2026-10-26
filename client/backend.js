// In-browser replacement for the Node server's /api routes. The review UI calls
// the same paths; this module answers them from memory and IndexedDB.
import pdfjs, { standardFontDataUrl, cMapUrl } from './pdfjs-setup.js';
import { parseDocument } from '../src/parse-core.js';
import { zip } from '../src/zip.js';
import { createEngine } from './engine.js';
import { idbStorage } from './storage.js';
import { rasterize, rasterNote, startRasterizer } from './raster.js';

const rasterReady = startRasterizer();

const PDF_PARSE_OPTS = {
  standardFontDataUrl,
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  verbosity: 0,
};

async function parseBytes(bytes) {
  const task = pdfjs.getDocument({ data: bytes.slice(), ...PDF_PARSE_OPTS });
  const doc = await task.promise;
  try {
    return await parseDocument(doc, { OPS: pdfjs.OPS });
  } finally {
    await doc.destroy().catch(() => {});
  }
}

const engine = createEngine({ storage: idbStorage(), parseBytes, rasterize });

const thumbs = new Map();
function clearThumbs() {
  for (const url of thumbs.values()) URL.revokeObjectURL(url);
  thumbs.clear();
}

function saveBlob(filename, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function withNote(run) {
  await run();
  await rasterReady;
  engine.setRasterNote(rasterNote());
  clearThumbs();
  return engine.state();
}

function stemOf(file) {
  return String(file || 'assets').replace(/\.[^.]+$/, '');
}

const backend = {
  async request(method, url, body) {
    const u = new URL(url, 'http://local');
    const p = u.pathname;
    const m = method.toUpperCase();
    try {
      if (m === 'GET' && p === '/api/state') return engine.state();
      if (m === 'POST' && p === '/api/open') return withNote(() => engine.open(body?.name));
      if (m === 'POST' && p === '/api/preview-box') return engine.previewBox(body.page, body.bbox);
      if (m === 'POST' && p === '/api/assets') return engine.addAsset(body.page, body.bbox, body.name);
      let match;
      if ((match = p.match(/^\/api\/assets\/([^/]+)$/))) {
        const id = decodeURIComponent(match[1]);
        if (m === 'PATCH') return engine.patchAsset(id, body || {});
        if (m === 'DELETE') return engine.deleteOne(id);
      }
      if (m === 'POST' && p === '/api/delete') return engine.deleteAssets(body?.ids);
      if (m === 'POST' && p === '/api/exclude') return engine.exclude(body?.ids, body?.exclude);
      if (m === 'POST' && p === '/api/merge') return engine.merge(body?.ids);
      if (m === 'POST' && p === '/api/split') return engine.split(body?.id, body?.gap);
      if (m === 'POST' && p === '/api/redetect') return engine.redetect(body?.page, body?.options);
      if (m === 'POST' && p === '/api/undo') return engine.undo();
      if (m === 'POST' && p === '/api/redo') return engine.redo();
      throw new Error('not found');
    } catch (e) {
      throw new Error(e.message || 'request failed');
    }
  },

  thumbURL(asset, key) {
    if (thumbs.size > 400) clearThumbs();
    if (!thumbs.has(key)) {
      const svg = engine.assetSVG(asset.id);
      thumbs.set(key, URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })));
    }
    return thumbs.get(key);
  },

  // The static app has no URL to put on an <a href>. Null tells the UI to
  // download through downloadAsset instead.
  downloadHref() {
    return null;
  },

  async readAsset(id) {
    return engine.assetSVG(id);
  },

  async downloadAsset(id, ext, scale) {
    const name = engine.assetName(id);
    if (ext === 'png') {
      await rasterReady;
      const png = await engine.assetPNG(id, scale);
      saveBlob(`${name}.png`, png, 'image/png');
      return;
    }
    saveBlob(`${name}.svg`, engine.assetSVG(id), 'image/svg+xml');
  },

  pdfOpenParams() {
    return {
      data: engine.sourceBytes(),
      standardFontDataUrl,
      cMapUrl,
      cMapPacked: true,
      verbosity: 0,
    };
  },

  exportZipHref() {
    return null;
  },

  async downloadZip(opts) {
    await rasterReady;
    engine.setRasterNote(rasterNote());
    const { file } = await engine.state();
    const { files } = await engine.exportFiles({ formats: opts.formats, scale: opts.scale });
    saveBlob(`${stemOf(file)}-assets.zip`, zip(files), 'application/zip');
  },

  async exportFolder(opts) {
    if (typeof showDirectoryPicker !== 'function') {
      throw new Error('This browser cannot pick a folder. Use Download .zip.');
    }
    let dir;
    try {
      dir = await showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      if (e?.name === 'AbortError') throw new Error('Save cancelled.');
      throw e;
    }
    await rasterReady;
    const { files, manifest } = await engine.exportFiles({ formats: opts.formats, scale: opts.scale });
    for (const f of files) {
      const handle = await dir.getFileHandle(f.name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(f.data);
      await writable.close();
    }
    return { out: dir.name, count: manifest.assets.filter((a) => !a.skipped).length, manifest };
  },

  async upload(file) {
    clearThumbs();
    await engine.upload(file);
    await rasterReady;
    engine.setRasterNote(rasterNote());
    return engine.state();
  },
};

export default backend;
