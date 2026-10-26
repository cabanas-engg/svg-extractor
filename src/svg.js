// Write a subset of a page's elements as a standalone SVG with a tight viewBox.
// PNG rasterisation lives in svg-png.js (Node, resvg-js) and client/raster.js
// (browser, resvg-wasm) so this file stays free of native and Node imports.
const n = (v) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};
const matrix = (m) => `matrix(${m.map(n).join(' ')})`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const CAPS = ['butt', 'round', 'square'];
const JOINS = ['miter', 'round', 'bevel'];

function pathTag(el) {
  const a = [`d="${el.d}"`, `transform="${matrix(el.transform)}"`];
  a.push(`fill="${el.fill}"`);
  if (el.fill !== 'none') {
    if (el.fillRule === 'evenodd') a.push('fill-rule="evenodd"');
    if (el.fillOpacity < 1) a.push(`fill-opacity="${n(el.fillOpacity)}"`);
  }
  if (el.stroke !== 'none') {
    a.push(`stroke="${el.stroke}"`, `stroke-width="${n(el.strokeWidth)}"`);
    if (el.lineCap) a.push(`stroke-linecap="${CAPS[el.lineCap]}"`);
    if (el.lineJoin) a.push(`stroke-linejoin="${JOINS[el.lineJoin]}"`);
    if (el.lineJoin === 0 && el.miterLimit !== 4) a.push(`stroke-miterlimit="${n(el.miterLimit)}"`);
    if (el.dash) {
      a.push(`stroke-dasharray="${el.dash.array.map(n).join(' ')}"`);
      if (el.dash.phase) a.push(`stroke-dashoffset="${n(el.dash.phase)}"`);
    }
    if (el.strokeOpacity < 1) a.push(`stroke-opacity="${n(el.strokeOpacity)}"`);
  }
  return `<path ${a.join(' ')}/>`;
}

function elementTag(el) {
  if (el.type === 'path') return pathTag(el);
  if (el.type === 'image') {
    if (!el.href) return `<!-- image omitted: data unavailable -->`;
    const op = el.opacity < 1 ? ` opacity="${n(el.opacity)}"` : '';
    return `<image width="1" height="1" preserveAspectRatio="none" transform="${matrix(el.transform)}"${op} href="${el.href}"/>`;
  }
  if (el.type === 'text') {
    return `<text transform="${matrix(el.transform)}" font-size="1" font-family="${esc(el.fontName)}, sans-serif" fill="${el.fill}">${esc(el.str)}</text>`;
  }
  return '';
}

/**
 * @param page      parsed page (for clip path definitions)
 * @param elements  elements to include, in paint order
 * @param box       [x0,y0,x1,y1] viewport-space crop
 */
export function buildSVG(page, elements, box, { idPrefix = '' } = {}) {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0, h = y1 - y0;
  const ordered = [...elements].sort((a, b) => order(a.id) - order(b.id));

  const usedClips = new Set(ordered.flatMap((e) => e.clips || []));
  const defs = [...usedClips].map((id) => {
    const c = page.clipPaths[id];
    const rule = c.evenOdd ? ' clip-rule="evenodd"' : '';
    return `<clipPath id="${idPrefix}${id}" clipPathUnits="userSpaceOnUse"><path d="${c.d}" transform="${matrix(c.transform)}"${rule}/></clipPath>`;
  });

  // Group runs of elements that share a clip chain, nesting one <g> per clip.
  const body = [];
  let i = 0;
  while (i < ordered.length) {
    const chain = (ordered[i].clips || []).join(',');
    let j = i;
    const run = [];
    while (j < ordered.length && (ordered[j].clips || []).join(',') === chain) run.push(elementTag(ordered[j++]));
    const clips = chain ? chain.split(',') : [];
    body.push(clips.map((c) => `<g clip-path="url(#${idPrefix}${c})">`).join('') + run.join('') + '</g>'.repeat(clips.length));
    i = j;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}" height="${n(h)}" viewBox="${n(x0)} ${n(y0)} ${n(w)} ${n(h)}">` +
    (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
    body.join('') +
    `</svg>\n`
  );
}

// element ids are p{page}e{index}; paint order = index
const order = (id) => Number(id.slice(id.indexOf('e') + 1));
