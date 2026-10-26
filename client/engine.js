// In-browser document: parse/detect/session/export with no server. Storage and
// the PDF parser and the PNG rasteriser are injected so Node tests can run the
// same edits the page does.
import { createSession, addManualAsset, mergeAssets, splitAsset, updateAsset, deleteAsset, redetectPage, selectInBox, SESSION_VERSION } from '../src/session-core.js';
import { renderAssetSVG, buildExport } from '../src/export-core.js';
import { hasPdfHeader } from '../src/parse-core.js';
import {
  MAX_UPLOAD, PDF_COMPAT_MESSAGE, fail, parseScale, parseFormats, checkBox, parseOptions, safeName, isSourceName,
} from '../src/validate.js';

const MAX_HISTORY = 100;

async function sha256Of(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createEngine({ storage, parseBytes, rasterize }) {
  let doc = null;

  const need = () => {
    if (!doc) throw fail(409, 'no file open: upload one first');
    return doc;
  };

  async function persist() {
    if (!doc) return;
    try {
      await storage.saveSession(doc.name, doc.session, doc.session.assets.length);
      doc.persistError = null;
    } catch (e) {
      doc.persistError = e?.message || String(e);
    }
  }

  const history = () => (need().history ||= { undo: [], redo: [] });

  // Same contract as the server's edit(): snapshot, roll back on throw, and
  // record nothing when the session did not change.
  async function edit(fn) {
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
      await persist();
    }
    return result;
  }

  async function travel(from, to) {
    const h = history();
    if (!h[from].length) throw fail(409, `nothing to ${from}`);
    h[to].push(JSON.stringify(doc.session));
    doc.session = JSON.parse(h[from].pop());
    await persist();
  }

  function findAsset(id) {
    const a = need().session.assets.find((x) => x.id === id);
    if (!a) throw fail(404, `no asset ${id}`);
    return a;
  }

  function pageOf(n) {
    const p = need().pages.get(Number(n));
    if (!p) throw fail(404, `page ${n} not loaded`);
    return p;
  }

  async function state() {
    const recent = await storage.list();
    const base = {
      workspace: 'this browser (not uploaded anywhere)',
      recent,
      maxUpload: MAX_UPLOAD,
      client: true,
    };
    if (!doc) return { ...base, empty: true };
    const { session, parsed } = doc;
    const warnings = [...(parsed.warnings || [])];
    if (doc.persistError) {
      warnings.push(`could not save this session in the browser (${doc.persistError}). It will last until you close the tab.`);
    }
    if (doc.rasterNote) warnings.push(doc.rasterNote);
    return {
      ...base,
      empty: false,
      file: doc.name,
      docId: doc.id,
      sessionPath: `${doc.name}.extract.json`,
      exportDir: doc.name.replace(/\.[^.]+$/, '') + '-assets',
      options: session.options,
      pages: session.pages,
      assets: session.assets,
      labels: session.labels,
      warnings,
      stale: !!session.stale,
      canUndo: !!doc.history?.undo.length,
      canRedo: !!doc.history?.redo.length,
    };
  }

  async function adopt(name, bytes, sha, { created }) {
    let parsed;
    try {
      parsed = await parseBytes(bytes, name);
    } catch (e) {
      if (created) await storage.delete(name).catch(() => {});
      if (e?.status) throw e;
      throw fail(422, `could not read ${name}: ${e.message}`);
    }
    parsed.file = name;
    parsed.sha256 = sha;

    let session = null;
    let fromDisk = false;
    try {
      const stored = await storage.getSession(name);
      if (stored?.version === SESSION_VERSION && stored.source) {
        session = stored;
        session.stale = !!(stored.source.sha256 && stored.source.sha256 !== sha);
        fromDisk = true;
      }
    } catch {
      // A broken saved session should not block opening the file.
    }
    if (!session) session = createSession(parsed);

    doc = {
      name,
      bytes,
      sha,
      parsed,
      session,
      id: crypto.randomUUID(),
      pages: new Map(parsed.pages.map((p) => [p.page, p])),
      history: { undo: [], redo: [] },
      persistError: null,
      rasterNote: null,
    };
    if (!fromDisk) await persist();
    return state();
  }

  async function upload(file) {
    if (!file) throw fail(400, 'empty upload');
    const declared = Number(file.size);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD) {
      throw fail(413, `file too large (max ${MAX_UPLOAD / 1024 / 1024} MB)`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.length) throw fail(400, 'empty upload');
    if (bytes.length > MAX_UPLOAD) throw fail(413, `file too large (max ${MAX_UPLOAD / 1024 / 1024} MB)`);
    if (!hasPdfHeader(bytes)) throw fail(415, PDF_COMPAT_MESSAGE);

    let name = safeName(file.name);
    if (!isSourceName(name)) name += '.pdf';
    const sha = await sha256Of(bytes);
    const stem = name.replace(/\.(ai|pdf)$/i, '');
    const ext = name.slice(stem.length);

    let chosen = name;
    let created = true;
    for (let i = 1; ; i++) {
      const candidate = i === 1 ? name : `${stem}-${i}${ext}`;
      const existing = await storage.getMeta(candidate);
      if (!existing) {
        chosen = candidate;
        break;
      }
      if (existing.sha256 === sha) {
        chosen = candidate;
        created = false;
        break;
      }
    }

    let fileError = null;
    if (created) {
      try {
        await storage.putFile(chosen, bytes, { name: chosen, size: bytes.length, modified: Date.now(), sha256: sha, assets: null });
      } catch (e) {
        fileError = e?.message || String(e);
      }
    }
    const result = await adopt(chosen, bytes, sha, { created: created && !fileError });
    if (fileError && doc) doc.persistError = fileError;
    return fileError ? state() : result;
  }

  async function open(name) {
    const base = safeName(String(name || ''));
    if (!isSourceName(base)) throw fail(404, `${name} is not in the workspace`);
    const meta = await storage.getMeta(base);
    const bytes = meta && await storage.getBytes(base);
    if (!meta || !bytes) throw fail(404, `${name} is not in the workspace`);
    return adopt(base, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), meta.sha256, { created: false });
  }

  function assetSVG(id) {
    const a = findAsset(id);
    return renderAssetSVG(pageOf(a.page), a, { pad: doc.session.options.pad });
  }

  function assetName(id) {
    return findAsset(id).name;
  }

  async function assetPNG(id, scale) {
    const svg = assetSVG(id);
    return rasterize(svg, { scale: parseScale(scale) });
  }

  async function exportFiles({ formats, scale, contactSheet = true } = {}) {
    const parsedFormats = parseFormats(formats);
    const parsedScale = parseScale(scale);
    return buildExport(need().parsed, doc.session, { formats: parsedFormats, scale: parsedScale, contactSheet }, rasterize);
  }

  function sourceBytes() {
    return need().bytes.slice();
  }

  function setRasterNote(note) {
    if (!doc) return;
    doc.rasterNote = note;
  }

  return {
    state,
    upload,
    open,
    assetSVG,
    assetName,
    assetPNG,
    exportFiles,
    sourceBytes,
    setRasterNote,
    previewBox(page, bbox) {
      return { count: selectInBox(pageOf(page), bbox).length };
    },
    async addAsset(page, bbox, name) {
      pageOf(page);
      const asset = await edit(() => addManualAsset(doc.session, page, checkBox(bbox), name));
      return { asset, ...(await state()) };
    },
    async patchAsset(id, patch) {
      if (patch?.bbox) checkBox(patch.bbox);
      const real = findAsset(id).id;
      await edit(() => updateAsset(doc.session, real, patch));
      return state();
    },
    async deleteOne(id) {
      const real = findAsset(id).id;
      await edit(() => deleteAsset(doc.session, real));
      return state();
    },
    async deleteAssets(ids) {
      if (!Array.isArray(ids) || !ids.length) throw fail(400, 'ids must be a non-empty array');
      ids.forEach(findAsset);
      await edit(() => ids.forEach((id) => deleteAsset(doc.session, id)));
      return state();
    },
    async exclude(ids, exclude) {
      if (!Array.isArray(ids) || !ids.length) throw fail(400, 'ids must be a non-empty array');
      ids.forEach(findAsset);
      await edit(() => ids.forEach((assetId) => updateAsset(doc.session, assetId, { exclude: !!exclude })));
      return state();
    },
    async merge(ids) {
      if (!Array.isArray(ids) || ids.length < 2) throw fail(400, 'select at least two assets to merge');
      const first = findAsset(ids[0]);
      const asset = await edit(() => mergeAssets(doc.session, pageOf(first.page), ids));
      return { asset, ...(await state()) };
    },
    async split(id, gap) {
      const a = findAsset(id);
      const parts = await edit(() => splitAsset(doc.session, pageOf(a.page), id, gap));
      if (!parts) throw fail(422, 'nothing to split: the elements in this box touch each other. Draw boxes by hand instead.');
      return { parts, ...(await state()) };
    },
    async redetect(page, options) {
      const opts = parseOptions(options);
      await edit(() => redetectPage(doc.session, pageOf(page), opts));
      return state();
    },
    async undo() {
      await travel('undo', 'redo');
      return state();
    },
    async redo() {
      await travel('redo', 'undo');
      return state();
    },
  };
}
