// Turn a parsed page into candidate assets.
//
//   1. classify   every element: background | rule | speck | text | geometry
//   2. text rows  outlined glyphs look like any other path, so find runs of
//                 small, similarly sized, baseline-aligned shapes and call them text
//   3. cluster    union geometry whose bboxes sit within `gap` of each other
//   4. labels     attach the nearest text block to each cluster, for naming
//
// All of this is heuristic. Every threshold lives in DEFAULTS so it can be tuned
// per file from the CLI or the UI — expect to need to, on real mockups.

export const DEFAULTS = {
  gap: 10, // pt: geometry closer than this is one asset
  pad: 1, // pt: padding around exported crops
  minAssetSize: 3, // pt: clusters smaller than this (both dims) are dropped
  speckSize: 1, // pt: single elements smaller than this are ignored
  backgroundArea: 0.2, // fraction of page area: bigger elements are backgrounds/panels
  ruleLength: 0.35, // fraction of page width/height for divider rules...
  ruleThickness: 3, // ...no thicker than this (pt)
  // outlined-text heuristic
  maxGlyphHeight: 36, // pt
  minGlyphs: 3,
  glyphGap: 0.7, // max horizontal gap between glyphs, × glyph height
  glyphHeightRatio: 2.2, // max height ratio between neighbouring glyphs
  baselineTolerance: 0.2, // × median glyph height
  baselineShare: 0.6, // share of glyphs that must sit on the baseline
  lineGap: 0.9, // max vertical gap between lines of one label, × line height
  labelDistance: 1.5, // how far a label may sit from its asset, × asset height (min 24pt)
};

const W = (b) => b[2] - b[0];
const H = (b) => b[3] - b[1];
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const unionAll = (bs) => bs.reduce(union);
const contains = (outer, inner, tol = 0.5) =>
  inner[0] >= outer[0] - tol && inner[1] >= outer[1] - tol && inner[2] <= outer[2] + tol && inner[3] <= outer[3] + tol;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};
export const boxGap = (a, b) => {
  const dx = Math.max(0, a[0] - b[2], b[0] - a[2]);
  const dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
  return Math.hypot(dx, dy);
};

class DSU {
  constructor(n) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(i) {
    while (this.p[i] !== i) i = this.p[i] = this.p[this.p[i]];
    return i;
  }
  union(a, b) {
    this.p[this.find(a)] = this.find(b);
  }
  groups() {
    const m = new Map();
    this.p.forEach((_, i) => {
      const r = this.find(i);
      if (!m.has(r)) m.set(r, []);
      m.get(r).push(i);
    });
    return [...m.values()];
  }
}

// Pairwise linking with an x-sorted sweep so dense pages stay fast.
function linkBoxes(boxes, reach, linked) {
  const dsu = new DSU(boxes.length);
  const idx = boxes.map((_, i) => i).sort((a, b) => boxes[a][0] - boxes[b][0]);
  for (let ii = 0; ii < idx.length; ii++) {
    const i = idx[ii];
    const ri = reach(i);
    for (let jj = ii + 1; jj < idx.length; jj++) {
      const j = idx[jj];
      if (boxes[j][0] > boxes[i][2] + Math.max(ri, reach(j))) break;
      if (linked(i, j)) dsu.union(i, j);
    }
  }
  return dsu.groups();
}

// ---------------------------------------------------------------------------
// outlined text

const iou = (a, b) => {
  const iw = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const ih = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (iw <= 0 || ih <= 0) return 0;
  const i = iw * ih;
  return i / (W(a) * H(a) + W(b) * H(b) - i);
};

/**
 * Given glyph-candidate boxes, return groups (index arrays) that look like
 * lines of text. `colors` (optional, parallel to boxes) enables the
 * single-colour check.
 */
export function findTextRows(boxes, o, colors) {
  const cand = boxes.map((b, i) => i).filter((i) => {
    const h = H(boxes[i]);
    return h > 0 && h <= o.maxGlyphHeight && W(boxes[i]) <= 2.5 * h + 2;
  });

  // Fold near-duplicates into one unit. Outlined Illustrator art often paints
  // each shape twice — the shape plus a slightly larger white knockout
  // ("halo") behind it — which would otherwise double the glyph count.
  const dup = linkBoxes(cand.map((i) => boxes[i]), () => 0, (i, j) => iou(boxes[cand[i]], boxes[cand[j]]) >= 0.6);
  const units = dup.map((g) => {
    const members = g.map((k) => cand[k]);
    return { members, box: unionAll(members.map((i) => boxes[i])), colors: new Set(colors ? members.map((i) => colors[i]) : []) };
  });

  const cb = units.map((u) => u.box);
  const groups = linkBoxes(
    cb,
    (i) => o.glyphGap * H(cb[i]),
    (i, j) => {
      const a = cb[i], b = cb[j];
      const ha = H(a), hb = H(b);
      if (Math.max(ha, hb) / Math.min(ha, hb) > o.glyphHeightRatio) return false;
      const vOverlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      if (vOverlap < 0.5 * Math.min(ha, hb)) return false;
      const hGap = Math.max(a[0], b[0]) - Math.min(a[2], b[2]);
      // glyph boxes may touch or kern slightly, but don't overlap much
      return hGap <= o.glyphGap * Math.max(ha, hb) && hGap >= -0.2 * Math.min(W(a), W(b));
    },
  );
  const rows = [];
  for (const g of groups) {
    if (g.length < o.minGlyphs) continue;
    const gb = g.map((i) => cb[i]);
    // A word is one colour (white knockouts aside); icons usually mix colours.
    if (colors) {
      const counts = new Map();
      for (const i of g) for (const c of units[i].colors) if (c !== '#ffffff') counts.set(c, (counts.get(c) || 0) + 1);
      if (!counts.size || Math.max(...counts.values()) < 0.8 * g.length) continue;
    }
    const mh = median(gb.map(H));
    const mb = median(gb.map((b) => b[3]));
    const onBaseline = gb.filter((b) => Math.abs(b[3] - mb) <= o.baselineTolerance * mh).length;
    if (onBaseline / gb.length < o.baselineShare) continue;
    const rb = unionAll(gb);
    if (W(rb) < 1.5 * H(rb)) continue;
    // A run of identical shapes (dashes, dots, a row of tiny squares) is a
    // pattern, not a word.
    const same = gb.filter((b) => Math.abs(W(b) - W(gb[0])) < 0.03 * mh && Math.abs(H(b) - H(gb[0])) < 0.03 * mh).length;
    if (same / gb.length >= 0.8 && gb.length >= 3) continue;
    rows.push(g.flatMap((i) => units[i].members));
  }
  return rows;
}

// Outer subpaths only (drop counters/holes like the inside of "O").
function outerSubpaths(subs) {
  return subs.filter((s, i) => !subs.some((t, j) => j !== i && contains(t, s, 0.01) && (W(t) * H(t) > W(s) * H(s))));
}

export function classify(page, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const pageArea = page.width * page.height;
  const role = new Map();
  for (const el of page.elements) {
    const b = el.bbox, w = W(b), h = H(b);
    let r = 'geometry';
    if (el.type === 'text') r = 'text';
    else if (w * h >= o.backgroundArea * pageArea || (w >= 0.9 * page.width && h >= 0.9 * page.height)) r = 'background';
    else if ((w >= o.ruleLength * page.width && h <= o.ruleThickness) || (h >= o.ruleLength * page.height && w <= o.ruleThickness)) r = 'rule';
    else if (Math.max(w, h) < o.speckSize) r = 'speck';
    role.set(el.id, r);
  }

  // Outlined text, case 1: one path per glyph.
  const geo = page.elements.filter((e) => role.get(e.id) === 'geometry' && e.type === 'path');
  const rows = findTextRows(geo.map((e) => e.bbox), o, geo.map((e) => (e.fill !== 'none' ? e.fill : e.stroke))).map((r) => r.map((i) => geo[i]));
  for (const row of rows) for (const e of row) role.set(e.id, 'text');

  // Outlined text, case 2: a whole word/line as one compound path.
  for (const e of geo) {
    if (role.get(e.id) !== 'geometry' || !e.subpaths || e.subpaths.length < o.minGlyphs) continue;
    if (H(e.bbox) > o.maxGlyphHeight) continue;
    const subs = outerSubpaths(e.subpaths);
    const subRows = findTextRows(subs, o);
    const covered = subRows.reduce((s, r) => s + r.length, 0);
    if (subRows.length && covered / subs.length >= 0.8) role.set(e.id, 'text');
  }

  // Punctuation and other small marks sitting inside a text row's band.
  const textEls = page.elements.filter((e) => role.get(e.id) === 'text');
  const textRows = groupTextLines(textEls, o);
  for (const e of geo) {
    if (role.get(e.id) !== 'geometry') continue;
    for (const row of textRows) {
      const rh = H(row.bbox);
      if (H(e.bbox) < 0.6 * rh && e.bbox[1] >= row.bbox[1] - 0.2 * rh && e.bbox[3] <= row.bbox[3] + 0.35 * rh &&
          e.bbox[0] >= row.bbox[0] - o.glyphGap * rh && e.bbox[2] <= row.bbox[2] + o.glyphGap * rh) {
        role.set(e.id, 'text');
        break;
      }
    }
  }
  return role;
}

// Group text elements into lines (by vertical overlap + proximity).
function groupTextLines(els, o) {
  const boxes = els.map((e) => e.bbox);
  return linkBoxes(
    boxes,
    (i) => o.glyphGap * H(boxes[i]) + 2,
    (i, j) => {
      const a = boxes[i], b = boxes[j];
      const vOverlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      if (vOverlap < 0.4 * Math.min(H(a), H(b))) return false;
      const hGap = Math.max(a[0], b[0]) - Math.min(a[2], b[2]);
      return hGap <= o.glyphGap * Math.max(H(a), H(b)) + 2;
    },
  ).map((g) => ({ els: g.map((i) => els[i]), bbox: unionAll(g.map((i) => boxes[i])) }));
}

// Stack lines into label blocks ("COUNTERWEIGHT" / "ON THE LEFT").
function groupLabelBlocks(lines, o) {
  const boxes = lines.map((l) => l.bbox);
  const groups = linkBoxes(
    boxes,
    () => Infinity,
    (i, j) => {
      const a = boxes[i], b = boxes[j];
      const lh = Math.max(H(a), H(b));
      const vGap = Math.max(a[1], b[1]) - Math.min(a[3], b[3]);
      if (vGap > o.lineGap * lh) return false;
      const hOverlap = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
      const ca = (a[0] + a[2]) / 2, cb = (b[0] + b[2]) / 2;
      return hOverlap > 0 || Math.abs(ca - cb) < 0.5 * Math.max(W(a), W(b));
    },
  );
  return groups.map((g) => {
    const ls = g.map((i) => lines[i]).sort((a, b) => a.bbox[1] - b.bbox[1]);
    const els = ls.flatMap((l) => l.els);
    const text = ls
      .map((l) => l.els.filter((e) => e.type === 'text').sort((a, b) => a.bbox[0] - b.bbox[0]).map((e) => e.str).join(' '))
      .filter(Boolean)
      .join(' ');
    return { elementIds: els.map((e) => e.id), bbox: unionAll(ls.map((l) => l.bbox)), text: text || null, outlined: !text };
  });
}

// ---------------------------------------------------------------------------

export function slug(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s-]+/g, '_').replace(/_+/g, '_').slice(0, 60);
}

/** Cluster a set of geometry elements by gap. Returns arrays of elements. */
export function clusterElements(els, gap) {
  const boxes = els.map((e) => e.bbox);
  return linkBoxes(boxes, () => gap, (i, j) => boxGap(boxes[i], boxes[j]) <= gap).map((g) => g.map((i) => els[i]));
}

function styleSummary(els) {
  const fills = new Set(), strokes = new Set();
  for (const e of els) {
    if (e.fill && e.fill !== 'none') fills.add(e.fill);
    if (e.stroke && e.stroke !== 'none') strokes.add(e.stroke);
  }
  return { fills: [...fills], strokes: [...strokes] };
}

export function makeAsset(page, els, extra = {}) {
  return {
    id: extra.id,
    page: page.page,
    kind: extra.kind || 'auto',
    bbox: unionAll(els.map((e) => e.bbox)).map((v) => Math.round(v * 100) / 100),
    elementIds: els.map((e) => e.id),
    styles: styleSummary(els),
    ...extra,
  };
}

/**
 * Detect assets on one parsed page.
 * @returns {{ assets, labels, roles }}
 */
export function detectPage(page, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const roles = classify(page, o);
  const byId = new Map(page.elements.map((e) => [e.id, e]));

  const geometry = page.elements.filter((e) => roles.get(e.id) === 'geometry');
  let clusters = clusterElements(geometry, o.gap).filter((c) => {
    const b = unionAll(c.map((e) => e.bbox));
    return Math.max(W(b), H(b)) >= o.minAssetSize;
  });

  const textEls = page.elements.filter((e) => roles.get(e.id) === 'text');
  const labels = groupLabelBlocks(groupTextLines(textEls, o), o);

  // Text, specks and rules that sit entirely inside an asset (lettering on an
  // icon, a tiny detail, a divider within a card) belong to it.
  const hostBoxes = clusters.map((c) => unionAll(c.map((e) => e.bbox)));
  const hostOf = (b) => hostBoxes.findIndex((hb) => contains(hb, b, 0));
  const extra = new Map();
  const adopt = (host, els) => {
    if (!extra.has(host)) extra.set(host, []);
    extra.get(host).push(...els);
  };
  const freeLabels = [];
  for (const lb of labels) {
    const host = hostOf(lb.bbox);
    if (host >= 0) adopt(host, lb.elementIds.map((id) => byId.get(id)));
    else freeLabels.push(lb);
  }
  for (const e of page.elements) {
    const r = roles.get(e.id);
    if (r !== 'speck' && r !== 'rule') continue;
    const host = hostOf(e.bbox);
    if (host >= 0) adopt(host, [e]);
  }
  clusters = clusters.map((c, i) => (extra.has(i) ? [...c, ...extra.get(i)] : c));

  let assets = clusters.map((c, i) => makeAsset(page, c, { id: `p${page.page}a${i}` }));
  assets = gridOrder(assets);
  freeLabels.forEach((l, i) => (l.id = `p${page.page}l${i}`));
  assignLabels(assets, freeLabels, o);
  return { assets, labels: freeLabels, roles };
}

// Reading order: rows top-to-bottom (by vertical overlap), then left-to-right.
export function gridOrder(assets) {
  const sorted = [...assets].sort((a, b) => a.bbox[1] - b.bbox[1]);
  const rows = [];
  for (const a of sorted) {
    const cy = (a.bbox[1] + a.bbox[3]) / 2;
    const row = rows.find((r) => cy >= r.top && cy <= r.bottom);
    if (row) {
      row.items.push(a);
      row.top = Math.min(row.top, a.bbox[1]);
      row.bottom = Math.max(row.bottom, a.bbox[3]);
    } else rows.push({ top: a.bbox[1], bottom: a.bbox[3], items: [a] });
  }
  rows.sort((a, b) => a.top - b.top);
  const out = [];
  rows.forEach((r, ri) => {
    r.items.sort((a, b) => a.bbox[0] - b.bbox[0]);
    r.items.forEach((a, ci) => {
      a.row = ri + 1;
      a.col = ci + 1;
      out.push(a);
    });
  });
  return out;
}

// Nearest label below (preferred) or above each asset; each label used once.
export function assignLabels(assets, labels, o = DEFAULTS) {
  const pairs = [];
  for (const a of assets) {
    const ah = H(a.bbox);
    const maxD = Math.max(24, o.labelDistance * ah);
    for (const l of labels) {
      const hOverlap = Math.min(a.bbox[2], l.bbox[2]) - Math.max(a.bbox[0], l.bbox[0]);
      const lc = (l.bbox[0] + l.bbox[2]) / 2;
      const aligned = hOverlap > 0.3 * Math.min(W(a.bbox), W(l.bbox)) || (lc >= a.bbox[0] && lc <= a.bbox[2]);
      if (!aligned) continue;
      const below = l.bbox[1] - a.bbox[3];
      const above = a.bbox[1] - l.bbox[3];
      if (below >= -2 && below <= maxD) pairs.push({ a, l, d: below });
      else if (above >= -2 && above <= maxD) pairs.push({ a, l, d: above * 1.5 + 1 }); // penalise "above"
    }
  }
  pairs.sort((x, y) => x.d - y.d);
  const usedA = new Set(), usedL = new Set();
  for (const { a, l } of pairs) {
    if (usedA.has(a) || usedL.has(l)) continue;
    usedA.add(a);
    usedL.add(l);
    a.labelId = l.id;
    a.labelBbox = l.bbox;
    if (l.text) a.labelText = l.text;
  }
  for (const a of assets) {
    a.suggestedName = a.labelText ? slug(a.labelText) : `p${a.page}_r${a.row}_c${a.col}`;
  }
}
