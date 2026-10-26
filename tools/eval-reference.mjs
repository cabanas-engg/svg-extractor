// Score detection against hand-made reference crops.
//
// Takes a folder of reference SVGs (one asset each, e.g. the hand-made crops
// from a real Illustrator mockup), lays them out on a mockup-style sheet with an outlined label
// under each, runs detection, and reports per reference whether it came back
// as exactly one asset with all of its paths and nothing else.
//
//   node tools/eval-reference.mjs <ref-dir> [--out sheet.pdf] [--set key=value ...]
//
// The sheet is synthetic (real icons, artificial layout), so this tests icon
// integrity and text/icon separation, not the spacing of a real mockup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import PDFDocument from 'pdfkit';
import { loadFont, outlinedText } from './outline.mjs';
import { parseFile } from '../src/parse.js';
import { detectPage, DEFAULTS } from '../src/detect.js';

function readRef(file) {
  const svg = fs.readFileSync(file, 'utf8');
  const [x, y, w, h] = svg.match(/viewBox="([^"]+)"/)[1].trim().split(/[\s,]+/).map(Number);
  const paths = [...svg.matchAll(/<path\b([^>]*)>/g)].map((m) => {
    const attr = (k) => m[1].match(new RegExp(`\\b${k}="([^"]*)"`))?.[1];
    return { d: attr('d'), fill: attr('fill') || '#000', rule: attr('fill-rule') === 'evenodd' ? 'even-odd' : 'non-zero', opacity: Number(attr('fill-opacity') ?? 1) };
  });
  for (const tag of new Set([...svg.matchAll(/<([a-zA-Z]+)\b/g)].map((m) => m[1]))) {
    if (!['svg', 'path'].includes(tag)) console.warn(`${path.basename(file)}: <${tag}> not reproduced on the test sheet`);
  }
  return { name: path.basename(file, '.svg'), x, y, w, h, paths };
}

// cairo writes fill="rgb(96.47%, 60.39%, 19.6%)"
function color(c) {
  const m = c.match(/rgb\(\s*([\d.]+)%\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/);
  if (!m) return c;
  return '#' + m.slice(1).map((v) => Math.round((Number(v) / 100) * 255).toString(16).padStart(2, '0')).join('');
}

// Lay references out in rows; big panels get a page of their own.
function layout(refs) {
  const pages = [];
  const small = refs.filter((r) => r.w <= 200 && r.h <= 200);
  const big = refs.filter((r) => !small.includes(r));
  const COLS = 6, CELL = 150, LABEL = 46, M = 50;
  const rows = Math.ceil(small.length / COLS);
  pages.push({
    width: M * 2 + COLS * CELL,
    height: M * 2 + rows * (CELL + LABEL),
    items: small.map((r, i) => {
      const cx = M + (i % COLS) * CELL + CELL / 2;
      const top = M + Math.floor(i / COLS) * (CELL + LABEL) + (CELL - r.h) / 2;
      return { ref: r, x: cx - r.w / 2, y: top };
    }),
  });
  // Large panels go at their original coordinates on a page as big as the
  // references imply the real mockup is (≥ their max extent). Page size matters:
  // the background rule is relative to page area.
  if (big.length) {
    const width = Math.max(1224, ...refs.map((r) => r.x + r.w + M));
    const height = Math.max(...refs.map((r) => r.y + r.h + LABEL + M));
    pages.push({ width, height, items: big.map((r) => ({ ref: r, x: r.x, y: r.y })) });
  }
  return pages;
}

function wrap(text, max = 18) {
  const lines = [];
  let cur = '';
  for (const w of text.split(' ')) {
    if (cur && (cur + ' ' + w).length > max) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

export async function buildSheet(refs, out) {
  const font = loadFont();
  const pages = layout(refs);
  const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
  const done = new Promise((res) => doc.pipe(fs.createWriteStream(out)).on('finish', res));
  for (const pg of pages) {
    doc.addPage({ size: [pg.width, pg.height] });
    for (const { ref, x, y } of pg.items) {
      doc.save();
      doc.translate(x - ref.x, y - ref.y);
      for (const p of ref.paths) doc.path(p.d).fillOpacity(p.opacity).fill(color(p.fill), p.rule);
      doc.restore();
      // outlined label, 14pt below the icon, like the mockups
      wrap(ref.name.replace(/_/g, ' ').toUpperCase()).forEach((line, li) => {
        outlinedText(doc, font, line, x + ref.w / 2, y + ref.h + 14 + 7 + li * 11, 9, '#636363');
      });
    }
  }
  doc.end();
  await done;
  return pages;
}

const W = (b) => b[2] - b[0], H = (b) => b[3] - b[1];
const area = (b) => Math.max(W(b), 0) * Math.max(H(b), 0);
const iou = (a, b) => {
  const i = area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
  return i / (area(a) + area(b) - i);
};

export async function evaluate(refDir, { out, opts = {} } = {}) {
  const refs = fs.readdirSync(refDir).filter((f) => f.endsWith('.svg')).sort().map((f) => readRef(path.join(refDir, f)));
  const sheet = out || path.join(os.tmpdir(), `ref-sheet-${process.pid}.pdf`);
  const pages = await buildSheet(refs, sheet);
  const parsed = await parseFile(sheet);
  const results = [];
  parsed.pages.forEach((page, pi) => {
    const { assets, roles } = detectPage(page, { ...DEFAULTS, ...opts });
    for (const { ref, x, y } of pages[pi].items) {
      const expect = [x, y, x + ref.w, y + ref.h];
      // the elements that were painted for this reference: everything inside its box that isn't the label
      const own = page.elements.filter((e) => e.bbox[0] >= expect[0] - 0.5 && e.bbox[1] >= expect[1] - 0.5 && e.bbox[2] <= expect[2] + 0.5 && e.bbox[3] <= expect[3] + 0.5);
      const ownIds = new Set(own.map((e) => e.id));
      const hits = assets.filter((a) => a.elementIds.some((id) => ownIds.has(id)));
      const best = hits.sort((a, b) => iou(b.bbox, expect) - iou(a.bbox, expect))[0];
      const got = new Set(hits.flatMap((a) => a.elementIds));
      const missing = own.filter((e) => !got.has(e.id));
      const extra = best ? best.elementIds.filter((id) => !ownIds.has(id)).length : 0;
      const missingRoles = {};
      for (const e of missing) missingRoles[roles.get(e.id)] = (missingRoles[roles.get(e.id)] || 0) + 1;
      results.push({
        name: ref.name,
        paths: ref.paths.length,
        assets: hits.length,
        iou: best ? iou(best.bbox, expect) : 0,
        missing: missing.length,
        missingRoles,
        extra,
        labelled: !!best?.labelId,
        ok: hits.length === 1 && missing.length === 0 && extra === 0,
      });
    }
  });
  return { sheet, results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, set: { type: 'string', multiple: true } } });
  if (!positionals[0]) {
    console.error('usage: node tools/eval-reference.mjs <ref-dir> [--out sheet.pdf] [--set key=value]');
    process.exit(1);
  }
  const opts = Object.fromEntries((v.set || []).map((kv) => kv.split('=')).map(([k, x]) => [k, Number(x)]));
  const { sheet, results } = await evaluate(positionals[0], { out: v.out, opts });
  console.log(`sheet: ${sheet}\n`);
  console.log('ok  name                                  paths  assets  iou    missing        extra  label');
  for (const r of results) {
    const miss = r.missing ? `${r.missing} ${JSON.stringify(r.missingRoles)}` : '0';
    console.log(`${r.ok ? '✓ ' : '✗ '}  ${r.name.padEnd(38)}${String(r.paths).padStart(5)}  ${String(r.assets).padStart(6)}  ${r.iou.toFixed(3)}  ${miss.padEnd(14)} ${String(r.extra).padStart(5)}  ${r.labelled ? 'yes' : 'no'}`);
  }
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} references extracted intact`);
}
