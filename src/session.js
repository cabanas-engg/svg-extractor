// A session is the editable result of detection: the list of assets per page,
// their names, and any manual corrections. It's a plain JSON file that sits
// next to the source (<file>.extract.json) so the CLI and the review UI share it.
//
// Elements are not stored — they're re-parsed from the source each time (ids
// are deterministic), and the source hash guards against the file changing
// underneath a saved session.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { DEFAULTS, detectPage, clusterElements, makeAsset, gridOrder, assignLabels, slug } from './detect.js';

export const SESSION_VERSION = 1;

export const defaultSessionPath = (file) => `${file}.extract.json`;

export function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function createSession(parsed, opts = {}) {
  const options = { ...DEFAULTS, ...opts };
  const session = {
    version: SESSION_VERSION,
    source: { path: path.basename(parsed.file), sha256: hashFile(parsed.file), numPages: parsed.numPages },
    options,
    pages: [],
    assets: [],
    labels: [],
  };
  for (const page of parsed.pages) {
    const { assets, labels } = detectPage(page, options);
    session.pages.push({ page: page.page, width: page.width, height: page.height });
    for (const a of assets) session.assets.push({ ...a, name: a.suggestedName, exclude: false });
    session.labels.push(...labels.map((l) => ({ ...l, page: page.page })));
  }
  return session;
}

export function loadSession(file, sourceFile) {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (s.version !== SESSION_VERSION) throw new Error(`${file}: unsupported session version ${s.version}`);
  if (sourceFile && s.source?.sha256 && s.source.sha256 !== hashFile(sourceFile)) {
    s.stale = true; // caller decides whether to warn or re-detect
  }
  return s;
}

export function saveSession(file, session) {
  const { stale, ...rest } = session;
  fs.writeFileSync(file, JSON.stringify(rest, null, 1) + '\n');
}

// ---------------------------------------------------------------------------
// element resolution

const area = (b) => Math.max(b[2] - b[0], 0.01) * Math.max(b[3] - b[1], 0.01);
const inter = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];

/**
 * Elements of a page that mostly (≥ minOverlap of their area) fall inside box.
 * Role doesn't matter here: a hand-drawn box around a card should get the
 * card's backing shape even if detection classed it as background, and a
 * page-sized background never falls mostly inside a smaller box anyway.
 */
export function selectInBox(page, box, { minOverlap = 0.5 } = {}) {
  return page.elements.filter((e) => {
    const i = inter(e.bbox, box);
    if (i[2] < i[0] || i[3] < i[1]) return false;
    // pad zero-width/height boxes (straight lines) so they can still qualify
    return area(i) / area(e.bbox) >= minOverlap;
  });
}

/** The elements an asset exports. Manual boxes are resolved spatially. */
export function assetElements(page, asset) {
  if (asset.kind === 'manual' || !asset.elementIds) return selectInBox(page, asset.bbox);
  const ids = new Set(asset.elementIds);
  return page.elements.filter((e) => ids.has(e.id));
}

// ---------------------------------------------------------------------------
// corrections

let counter = 0;
const newId = (page, tag) => `p${page}${tag}${Date.now().toString(36)}${(counter++).toString(36)}`;

function uniqueName(session, base, except) {
  const taken = new Set(session.assets.filter((a) => a !== except).map((a) => a.name));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

export function addManualAsset(session, pageNum, bbox, name) {
  const a = {
    id: newId(pageNum, 'm'),
    page: pageNum,
    kind: 'manual',
    bbox: bbox.map((v) => Math.round(v * 100) / 100),
    styles: null,
    exclude: false,
  };
  a.suggestedName = `p${pageNum}_manual`;
  a.name = uniqueName(session, name ? slug(name) : a.suggestedName);
  session.assets.push(a);
  return a;
}

export function mergeAssets(session, page, ids) {
  const parts = session.assets.filter((a) => ids.includes(a.id));
  if (parts.length < 2) throw new Error('merge needs at least two assets');
  if (new Set(parts.map((a) => a.page)).size > 1) throw new Error('cannot merge assets across pages');
  const els = [...new Map(parts.flatMap((a) => assetElements(page, a)).map((e) => [e.id, e])).values()];
  const merged = makeAsset(page, els, { id: newId(page.page, 'g'), kind: 'merged' });
  merged.name = parts[0].name;
  merged.suggestedName = parts[0].suggestedName;
  const labelled = parts.find((p) => p.labelId);
  if (labelled) Object.assign(merged, { labelId: labelled.labelId, labelBbox: labelled.labelBbox, labelText: labelled.labelText });
  merged.exclude = false;
  session.assets = session.assets.filter((a) => !ids.includes(a.id));
  session.assets.push(merged);
  return merged;
}

/** Re-cluster one asset's elements with a tighter gap. */
export function splitAsset(session, page, id, gap) {
  const a = session.assets.find((x) => x.id === id);
  if (!a) throw new Error(`no asset ${id}`);
  const els = assetElements(page, a);
  const g = gap ?? session.options.gap / 2;
  let groups = clusterElements(els, g);
  if (groups.length < 2) groups = clusterElements(els, 0);
  if (groups.length < 2) return null;
  let parts = groups.map((grp) => makeAsset(page, grp, { id: newId(page.page, 's'), kind: 'split' }));
  parts = gridOrder(parts);
  // Re-pair parts with labels that no other asset on the page has claimed.
  const claimed = new Set(session.assets.filter((x) => x.page === page.page && x.id !== id).map((x) => x.labelId));
  assignLabels(parts, session.labels.filter((l) => l.page === page.page && !claimed.has(l.id)), session.options);
  parts.forEach((p, i) => {
    p.suggestedName = p.labelText ? p.suggestedName : `${a.name}_${i + 1}`;
    p.name = uniqueName(session, p.suggestedName);
    p.exclude = false;
  });
  session.assets = session.assets.filter((x) => x.id !== id).concat(parts);
  return parts;
}

export function updateAsset(session, id, patch) {
  const a = session.assets.find((x) => x.id === id);
  if (!a) throw new Error(`no asset ${id}`);
  if (patch.name !== undefined) a.name = uniqueName(session, slug(patch.name) || a.suggestedName, a);
  if (patch.exclude !== undefined) a.exclude = !!patch.exclude;
  if (patch.bbox) {
    // A hand-adjusted box means "whatever is in here", not the old element set.
    a.bbox = patch.bbox.map((v) => Math.round(v * 100) / 100);
    a.kind = 'manual';
    delete a.elementIds;
  }
  return a;
}

export function deleteAsset(session, id) {
  session.assets = session.assets.filter((a) => a.id !== id);
}

/** Re-run detection on one page with new options, replacing its auto assets. */
export function redetectPage(session, page, opts) {
  Object.assign(session.options, opts);
  const { assets, labels } = detectPage(page, session.options);
  const keep = session.assets.filter((a) => a.page !== page.page || a.kind === 'manual');
  session.assets = keep.concat(assets.map((a) => ({ ...a, name: uniqueName({ assets: keep }, a.suggestedName), exclude: false })));
  session.labels = session.labels.filter((l) => l.page !== page.page).concat(labels.map((l) => ({ ...l, page: page.page })));
}
