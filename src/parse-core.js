// Parse a PDF (or PDF-compatible .ai) into flat, page-space vector elements.
//
// Walks PDF.js's operator list ourselves instead of rendering, so every painted
// path comes out with its own bbox, style and transform. Coordinates are in
// "viewport space": PDF points, origin top-left, y down (PDF.js viewport at
// scale 1). Each element keeps its path data in LOCAL user space plus the CTM
// that maps it to viewport space, so SVG export can emit it verbatim with a
// transform and get identical stroke scaling to the original.
// Shared by the Node CLI and the browser build. This file must not import
// Node builtins or a specific pdf.js build: the caller opens the document and
// passes the OPS table from that same build (operator codes have to match).
import { bytesToBase64, encodePNG } from './png.js';

// PDF convention: mul(m, n) applies m first, then n.
export function mul(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const fmt = (n) => {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

// ---------------------------------------------------------------------------
// bbox helpers ([x0, y0, x1, y1])

const emptyBox = () => [Infinity, Infinity, -Infinity, -Infinity];
function addPt(b, x, y) {
  if (x < b[0]) b[0] = x;
  if (y < b[1]) b[1] = y;
  if (x > b[2]) b[2] = x;
  if (y > b[3]) b[3] = y;
}
export function intersectBox(a, b) {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}
const isEmpty = (b) => !(b[2] >= b[0] && b[3] >= b[1]);

// Bezier extrema in 1D: roots of the derivative in (0,1).
function cubicExtrema(p0, p1, p2, p3) {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const ts = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      ts.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return ts.filter((t) => t > 0 && t < 1);
}
const cubicAt = (p0, p1, p2, p3, t) => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

// ---------------------------------------------------------------------------
// path building. Segments are kept in local space; bboxes in viewport space.

class PathBuilder {
  constructor() {
    this.d = [];
    this.subpaths = []; // viewport-space bbox per subpath (used by the text heuristic)
    this.cur = null;
    this.x = 0;
    this.y = 0;
    this.sx = 0;
    this.sy = 0;
  }
  get empty() {
    return this.d.length === 0;
  }
  _newSub(ctm) {
    this.cur = emptyBox();
    this.subpaths.push(this.cur);
    this.ctm = ctm;
  }
  _pt(ctm, x, y) {
    const [X, Y] = apply(ctm, x, y);
    addPt(this.cur, X, Y);
  }
  moveTo(ctm, x, y) {
    this._newSub(ctm);
    this.d.push(`M${fmt(x)} ${fmt(y)}`);
    this._pt(ctm, x, y);
    this.x = this.sx = x;
    this.y = this.sy = y;
  }
  lineTo(ctm, x, y) {
    if (!this.cur) this.moveTo(ctm, this.x, this.y);
    this.d.push(`L${fmt(x)} ${fmt(y)}`);
    this._pt(ctm, x, y);
    this.x = x;
    this.y = y;
  }
  curveTo(ctm, x1, y1, x2, y2, x3, y3) {
    if (!this.cur) this.moveTo(ctm, this.x, this.y);
    this.d.push(`C${fmt(x1)} ${fmt(y1)} ${fmt(x2)} ${fmt(y2)} ${fmt(x3)} ${fmt(y3)}`);
    // Exact bbox: transform control points first (affine maps preserve Beziers).
    const P = [apply(ctm, this.x, this.y), apply(ctm, x1, y1), apply(ctm, x2, y2), apply(ctm, x3, y3)];
    addPt(this.cur, P[3][0], P[3][1]);
    for (const k of [0, 1]) {
      for (const t of cubicExtrema(P[0][k], P[1][k], P[2][k], P[3][k])) {
        addPt(this.cur, cubicAt(P[0][0], P[1][0], P[2][0], P[3][0], t), cubicAt(P[0][1], P[1][1], P[2][1], P[3][1], t));
      }
    }
    this.x = x3;
    this.y = y3;
  }
  close() {
    if (!this.cur) return;
    this.d.push('Z');
    this.x = this.sx;
    this.y = this.sy;
  }
  rect(ctm, x, y, w, h) {
    this.moveTo(ctm, x, y);
    this.lineTo(ctm, x + w, y);
    this.lineTo(ctm, x + w, y + h);
    this.lineTo(ctm, x, y + h);
    this.close();
  }
  bbox() {
    const b = emptyBox();
    for (const s of this.subpaths) {
      if (isEmpty(s)) continue;
      addPt(b, s[0], s[1]);
      addPt(b, s[2], s[3]);
    }
    return b;
  }
}

// ---------------------------------------------------------------------------

const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

function colorArg(args) {
  if (typeof args[0] === 'string') return args[0]; // newer PDF.js passes a hex string
  return hex(args[0], args[1], args[2]);
}

function freshState(ctm) {
  return {
    ctm,
    fill: '#000000',
    stroke: '#000000',
    fillAlpha: 1,
    strokeAlpha: 1,
    lineWidth: 1,
    lineCap: 0,
    lineJoin: 0,
    miterLimit: 10,
    dash: null,
    clips: [], // [{ id, bbox }]
    clipBox: null,
  };
}

function opTables(OPS) {
  const PAINT = new Map([
    [OPS.fill, { fill: true }],
    [OPS.eoFill, { fill: true, evenOdd: true }],
    [OPS.stroke, { stroke: true }],
    [OPS.closeStroke, { stroke: true, close: true }],
    [OPS.fillStroke, { fill: true, stroke: true }],
    [OPS.eoFillStroke, { fill: true, stroke: true, evenOdd: true }],
    [OPS.closeFillStroke, { fill: true, stroke: true, close: true }],
    [OPS.closeEOFillStroke, { fill: true, stroke: true, evenOdd: true, close: true }],
    [OPS.endPath, {}],
  ]);
  const OPNAMES = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]));
  // Operators we knowingly ignore (they don't change painted geometry for our purposes).
  const IGNORED = new Set(
    [
      'dependency', 'setRenderingIntent', 'setFlatness', 'beginMarkedContent', 'beginMarkedContentProps',
      'endMarkedContent', 'markPoint', 'markPointProps', 'beginCompat', 'endCompat', 'paintSolidColorImageMask',
      'beginAnnotation', 'endAnnotation', 'setCharSpacing', 'setWordSpacing', 'setHScale', 'setLeading',
      'setLeadingMoveText', 'setTextRise', 'setTextRenderingMode', 'setFont', 'beginText', 'endText', 'moveText',
      'setTextMatrix', 'nextLine', 'setCharWidth', 'setCharWidthAndBounds', 'nextLineShowText',
      'nextLineSetSpacingShowText', 'showText', 'showSpacedText', 'setStrokeColorSpace', 'setFillColorSpace',
    ].map((n) => OPS[n]).filter((v) => v !== undefined),
  );
  return { PAINT, OPNAMES, IGNORED };
}

/**
 * Walk an already-open PDF.js document.
 * `OPS` must come from the same pdf.js build that produced `doc`.
 * @returns {Promise<{ numPages, pages: Page[], warnings: string[] }>}
 */
export async function parseDocument(doc, { pages: pageFilter, OPS } = {}) {
  if (!OPS) throw new Error('parseDocument requires the OPS table from the pdf.js build that opened the document');
  const warnings = [];
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    if (pageFilter && !pageFilter.includes(n)) continue;
    const page = await doc.getPage(n);
    pages.push(await parsePage(page, n, warnings, OPS));
  }
  return { numPages: doc.numPages, pages, warnings };
}

/** True when the leading bytes of a file contain a PDF header. */
export function hasPdfHeader(bytes) {
  const n = Math.min(1024, bytes.length);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[i]);
  return s.includes('%PDF-');
}

async function parsePage(page, pageNum, warnings, OPS) {
  const { PAINT, OPNAMES, IGNORED } = opTables(OPS);
  const viewport = page.getViewport({ scale: 1 });
  const opList = await page.getOperatorList();
  const elements = [];
  const clipPaths = []; // { id, d, transform, evenOdd }
  const unhandled = new Map();
  let nextId = 0;

  let st = freshState(viewport.transform.slice());
  const stack = [];
  let path = new PathBuilder();
  let pendingClip = null; // 'nonzero' | 'evenodd'

  const pushState = () => stack.push({ ...st, clips: st.clips.slice() });
  const popState = () => {
    if (stack.length) st = stack.pop();
  };

  function clippedBox(b) {
    return st.clipBox ? intersectBox(b, st.clipBox) : b;
  }

  function emit(el) {
    if (isEmpty(el.bbox)) return; // fully clipped away or degenerate
    el.id = `p${pageNum}e${nextId++}`;
    el.clips = st.clips.map((c) => c.id);
    elements.push(el);
  }

  async function imageData(objId) {
    const store = objId.startsWith('g_') ? page.commonObjs : page.objs;
    try {
      return await new Promise((resolve) => store.get(objId, resolve));
    } catch {
      return null;
    }
  }

  async function emitImage(img, isMask) {
    // Images paint the unit square of user space.
    const ctm = st.ctm;
    const b = emptyBox();
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) addPt(b, ...apply(ctm, x, y));
    let href = null;
    if (img) {
      try {
        href = 'data:image/png;base64,' + bytesToBase64(encodePNG(img, isMask ? st.fill : null));
      } catch (e) {
        warnings.push(`page ${pageNum}: could not encode image (${e.message})`);
      }
    }
    emit({
      type: 'image',
      href,
      width: img?.width,
      height: img?.height,
      // flip so the image's first row lands at user-space y=1, as PDF specifies
      transform: mul([1, 0, 0, -1, 0, 1], ctm),
      bbox: clippedBox(b),
      opacity: st.fillAlpha,
    });
  }

  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    switch (fn) {
      case OPS.save:
        pushState();
        break;
      case OPS.restore:
        popState();
        break;
      case OPS.transform:
        st.ctm = mul(args, st.ctm);
        break;
      case OPS.paintFormXObjectBegin: {
        pushState();
        const [matrix, bbox] = args;
        if (matrix) st.ctm = mul(matrix, st.ctm);
        if (bbox) {
          const p = new PathBuilder();
          p.rect(st.ctm, bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]);
          addClip(p, 'nonzero');
        }
        break;
      }
      case OPS.paintFormXObjectEnd:
        popState();
        break;
      case OPS.beginGroup:
        pushState();
        break;
      case OPS.endGroup:
        popState();
        break;

      case OPS.setLineWidth:
        st.lineWidth = args[0];
        break;
      case OPS.setLineCap:
        st.lineCap = args[0];
        break;
      case OPS.setLineJoin:
        st.lineJoin = args[0];
        break;
      case OPS.setMiterLimit:
        st.miterLimit = args[0];
        break;
      case OPS.setDash:
        st.dash = args[0]?.length ? { array: args[0], phase: args[1] } : null;
        break;
      case OPS.setGState:
        for (const [k, v] of args[0]) {
          if (k === 'LW') st.lineWidth = v;
          else if (k === 'LC') st.lineCap = v;
          else if (k === 'LJ') st.lineJoin = v;
          else if (k === 'ML') st.miterLimit = v;
          else if (k === 'D') st.dash = v?.[0]?.length ? { array: v[0], phase: v[1] } : null;
          else if (k === 'ca') st.fillAlpha = v;
          else if (k === 'CA') st.strokeAlpha = v;
          else if (k === 'BM' && v && v !== 'source-over' && v !== 'Normal') {
            unhandled.set(`blend mode ${v}`, (unhandled.get(`blend mode ${v}`) || 0) + 1);
          } else if (k === 'SMask' && v) unhandled.set('soft mask', (unhandled.get('soft mask') || 0) + 1);
        }
        break;
      case OPS.setFillRGBColor:
        st.fill = colorArg(args);
        break;
      case OPS.setStrokeRGBColor:
        st.stroke = colorArg(args);
        break;
      case OPS.setFillTransparent:
        st.fill = 'none';
        break;
      case OPS.setStrokeTransparent:
        st.stroke = 'none';
        break;
      case OPS.setFillColorN:
      case OPS.setStrokeColorN: {
        // Patterns/shadings: approximate with the first gradient stop. Flagged.
        const ir = args[0];
        let color = '#808080';
        if (Array.isArray(ir) && ir[0] === 'RadialAxial' && ir[3]?.[0]) color = ir[3][0][1];
        if (fn === OPS.setFillColorN) st.fill = color;
        else st.stroke = color;
        unhandled.set('pattern/gradient color (approximated as solid)', (unhandled.get('pattern/gradient color (approximated as solid)') || 0) + 1);
        break;
      }

      case OPS.constructPath: {
        const [ops, a] = args;
        for (let k = 0, j = 0; k < ops.length; k++) {
          switch (ops[k] | 0) {
            case OPS.moveTo:
              path.moveTo(st.ctm, a[j++], a[j++]);
              break;
            case OPS.lineTo:
              path.lineTo(st.ctm, a[j++], a[j++]);
              break;
            case OPS.curveTo:
              path.curveTo(st.ctm, a[j], a[j + 1], a[j + 2], a[j + 3], a[j + 4], a[j + 5]);
              j += 6;
              break;
            case OPS.curveTo2: // first control point = current point
              path.curveTo(st.ctm, path.x, path.y, a[j], a[j + 1], a[j + 2], a[j + 3]);
              j += 4;
              break;
            case OPS.curveTo3: // second control point = end point
              path.curveTo(st.ctm, a[j], a[j + 1], a[j + 2], a[j + 3], a[j + 2], a[j + 3]);
              j += 4;
              break;
            case OPS.closePath:
              path.close();
              break;
            case OPS.rectangle:
              path.rect(st.ctm, a[j], a[j + 1], a[j + 2], a[j + 3]);
              j += 4;
              break;
          }
        }
        break;
      }
      case OPS.closePath:
        path.close();
        break;
      case OPS.clip:
        pendingClip = 'nonzero';
        break;
      case OPS.eoClip:
        pendingClip = 'evenodd';
        break;

      case OPS.paintImageXObject:
        await emitImage(await imageData(args[0]), false);
        break;
      case OPS.paintInlineImageXObject:
        await emitImage(args[0], false);
        break;
      case OPS.paintImageMaskXObject:
        await emitImage(args[0], true);
        break;
      case OPS.paintImageXObjectRepeat:
      case OPS.paintImageMaskXObjectRepeat:
      case OPS.paintImageMaskXObjectGroup:
      case OPS.paintInlineImageXObjectGroup:
        unhandled.set(OPNAMES[fn], (unhandled.get(OPNAMES[fn]) || 0) + 1);
        break;
      case OPS.shadingFill:
        unhandled.set('shadingFill (smooth shade, skipped)', (unhandled.get('shadingFill (smooth shade, skipped)') || 0) + 1);
        break;

      default:
        if (PAINT.has(fn)) {
          paint(PAINT.get(fn));
        } else if (!IGNORED.has(fn)) {
          const name = OPNAMES[fn] || `op${fn}`;
          unhandled.set(name, (unhandled.get(name) || 0) + 1);
        }
    }
  }

  function addClip(p, rule) {
    const id = `p${pageNum}c${clipPaths.length}`;
    // Clip paths are stored in viewport space via their own transform.
    clipPaths.push({ id, d: p.d.join(''), transform: p.ctm || st.ctm, evenOdd: rule === 'evenodd' });
    const bb = p.bbox();
    st.clips.push({ id, bbox: bb });
    st.clipBox = st.clipBox ? intersectBox(st.clipBox, bb) : bb;
  }

  function paint(mode) {
    if (mode.close) path.close();
    const p = path;
    path = new PathBuilder();
    if (p.empty) {
      pendingClip = null;
      return;
    }
    // The clip set by W/W* applies to painting *after* this path op,
    // but the path itself is painted with the old clip.
    const clipRule = pendingClip;
    pendingClip = null;

    if (mode.fill || mode.stroke) {
      const hasStroke = mode.stroke && st.stroke !== 'none';
      const hasFill = mode.fill && st.fill !== 'none';
      if (hasFill || hasStroke) {
        const raw = p.bbox();
        // Stroke width in viewport units (approximate for skewed CTMs).
        const scale = Math.sqrt(Math.abs(st.ctm[0] * st.ctm[3] - st.ctm[1] * st.ctm[2]));
        const sw = st.lineWidth === 0 ? 1 / scale : st.lineWidth; // 0 = thinnest line
        const pad = hasStroke ? (sw * scale) / 2 : 0;
        const outer = [raw[0] - pad, raw[1] - pad, raw[2] + pad, raw[3] + pad];
        emit({
          type: 'path',
          d: p.d.join(''),
          transform: p.ctm,
          fill: hasFill ? st.fill : 'none',
          fillOpacity: st.fillAlpha,
          fillRule: mode.evenOdd ? 'evenodd' : 'nonzero',
          stroke: hasStroke ? st.stroke : 'none',
          strokeOpacity: st.strokeAlpha,
          strokeWidth: hasStroke ? sw : 0,
          lineCap: st.lineCap,
          lineJoin: st.lineJoin,
          miterLimit: st.miterLimit,
          dash: hasStroke ? st.dash : null,
          bbox: clippedBox(outer),
          rawBbox: outer,
          subpaths: p.subpaths.filter((s) => !isEmpty(s)).map((s) => s.map((v) => Math.round(v * 100) / 100)),
        });
      }
    }
    if (clipRule) addClip(p, clipRule);
  }

  // Real (non-outlined) text. We don't walk text ops for geometry; PDF.js's
  // text layer gives positioned strings, which is what labels/naming need.
  const tc = await page.getTextContent();
  for (const item of tc.items) {
    if (!item.str || !item.str.trim()) continue;
    const m = mul(item.transform, viewport.transform);
    const h = Math.hypot(item.transform[2], item.transform[3]) || item.height;
    const w = item.width;
    // item.transform maps a unit em at the baseline origin.
    const b = emptyBox();
    const tx = item.transform;
    const ux = [tx[0] / (Math.hypot(tx[0], tx[1]) || 1), tx[1] / (Math.hypot(tx[0], tx[1]) || 1)];
    for (const [x, y] of [[0, -0.22 * h], [w, -0.22 * h], [0, 0.9 * h], [w, 0.9 * h]]) {
      const px = tx[4] + ux[0] * x - ux[1] * y;
      const py = tx[5] + ux[1] * x + ux[0] * y;
      addPt(b, ...apply(viewport.transform, px, py));
    }
    emit({
      type: 'text',
      str: item.str,
      fontSize: h,
      fontName: tc.styles[item.fontName]?.fontFamily || 'sans-serif',
      // SVG text is y-down in em units (font-size=1); text space is y-up.
      transform: mul([1, 0, 0, -1, 0, 0], m),
      fill: '#000000',
      bbox: b,
    });
  }
  // Text colour isn't exposed by getTextContent; leave black and let the
  // designer fix it. Flag it so it isn't silent.
  if (tc.items.some((t) => t.str?.trim())) {
    warnings.push(`page ${pageNum}: contains live (non-outlined) text; exported text uses a fallback font and black fill`);
  }

  for (const [name, count] of unhandled) warnings.push(`page ${pageNum}: unsupported ${name} ×${count}`);

  return {
    page: pageNum,
    width: viewport.width,
    height: viewport.height,
    elements,
    clipPaths: Object.fromEntries(clipPaths.map((c) => [c.id, c])),
  };
}
