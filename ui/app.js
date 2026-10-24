// Review/correct UI. The page itself is rendered by PDF.js (ground truth: what
// the file really looks like); boxes are an SVG overlay in the same pt
// coordinate space the extractor uses. Thumbnails in the sidebar are the actual
// exported SVGs, so a bad crop is visible before export.
import * as pdfjs from '/pdfjs/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';

const $ = (s) => document.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';

const ui = {
  data: null,
  pdf: null,
  pageNum: 1,
  zoom: null, // null = fit width
  selected: new Set(),
  version: 0,
  renderTask: null,
};

// ---------------------------------------------------------------- api

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

async function mutate(method, url, body) {
  try {
    const r = await api(method, url, body);
    ui.data = { ...ui.data, ...pick(r) };
    ui.version++;
    for (const id of [...ui.selected]) if (!ui.data.assets.some((a) => a.id === id)) ui.selected.delete(id);
    renderAll();
    return r;
  } catch (e) {
    toast(e.message);
    return null;
  }
}
const pick = (r) => {
  const { asset, parts, ...rest } = r;
  return rest;
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ---------------------------------------------------------------- render

const pageInfo = () => ui.data.pages.find((p) => p.page === ui.pageNum);
// Current page's assets in reading order (rows by vertical overlap, then left to right).
function pageAssets() {
  const rows = [];
  for (const a of ui.data.assets.filter((x) => x.page === ui.pageNum).sort((p, q) => p.bbox[1] - q.bbox[1])) {
    const cy = (a.bbox[1] + a.bbox[3]) / 2;
    const row = rows.find((r) => cy >= r.top && cy <= r.bottom);
    if (row) {
      row.items.push(a);
      row.bottom = Math.max(row.bottom, a.bbox[3]);
    } else rows.push({ top: a.bbox[1], bottom: a.bbox[3], items: [a] });
  }
  return rows.flatMap((r) => r.items.sort((p, q) => p.bbox[0] - q.bbox[0]));
}

function effectiveZoom() {
  if (ui.zoom) return ui.zoom;
  const stage = $('#stage');
  return Math.max(0.2, (stage.clientWidth - 48) / pageInfo().width);
}

async function renderPage() {
  const info = pageInfo();
  const zoom = effectiveZoom();
  $('#zoomLabel').textContent = `${Math.round(zoom * 100)}%`;
  $('#pageLabel').textContent = `Page ${ui.pageNum} / ${ui.data.pages.length}`;
  const el = $('#page');
  el.style.width = `${info.width * zoom}px`;
  el.style.height = `${info.height * zoom}px`;
  $('#overlay').setAttribute('viewBox', `0 0 ${info.width} ${info.height}`);

  const page = await ui.pdf.getPage(ui.pageNum);
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: zoom * dpr });
  const canvas = $('#canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  ui.renderTask?.cancel();
  ui.renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport });
  try {
    await ui.renderTask.promise;
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') throw e;
  }
}

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
}

function drawOverlay() {
  const svg = $('#overlay');
  svg.replaceChildren();
  const zoom = effectiveZoom();
  const labels = ui.data.labels.filter((l) => l.page === ui.pageNum);
  for (const l of labels) {
    const [x0, y0, x1, y1] = l.bbox;
    svgEl('rect', { class: 'label', x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, svg);
  }
  for (const a of pageAssets()) {
    const [x0, y0, x1, y1] = a.bbox;
    if (a.labelBbox && !a.exclude) {
      const lb = a.labelBbox;
      svgEl('line', { class: 'link', x1: (x0 + x1) / 2, y1: a.labelBbox[1] > y1 ? y1 : y0, x2: (lb[0] + lb[2]) / 2, y2: lb[1] > y1 ? lb[1] : lb[3] }, svg);
    }
    const cls = ['box', a.kind, a.exclude ? 'excluded' : '', ui.selected.has(a.id) ? 'selected' : ''].join(' ');
    const r = svgEl('rect', { class: cls, x: x0, y: y0, width: x1 - x0, height: y1 - y0, 'data-id': a.id }, svg);
    svgEl('title', {}, r).textContent = a.name;
    const tag = svgEl('text', { class: 'tag', x: x0, y: y0 - 3 / zoom, 'font-size': 9 / zoom, 'stroke-width': 3 / zoom }, svg);
    tag.textContent = a.name;
  }
  // resize handles for a single selection
  if (ui.selected.size === 1) {
    const a = ui.data.assets.find((x) => ui.selected.has(x.id));
    if (a && a.page === ui.pageNum) {
      const s = 8 / zoom;
      const [x0, y0, x1, y1] = a.bbox;
      for (const [cx, cy, corner] of [[x0, y0, 'tl'], [x1, y0, 'tr'], [x0, y1, 'bl'], [x1, y1, 'br']]) {
        svgEl('rect', { class: 'handle', x: cx - s / 2, y: cy - s / 2, width: s, height: s, 'data-corner': corner, 'data-id': a.id }, svg);
      }
    }
  }
}

function renderList() {
  const list = $('#list');
  const assets = pageAssets();
  const included = ui.data.assets.filter((a) => !a.exclude).length;
  $('#count').textContent = `${assets.length} on page · ${included} to export`;
  list.replaceChildren(
    ...assets.map((a) => {
      const li = document.createElement('li');
      li.className = `item${ui.selected.has(a.id) ? ' selected' : ''}${a.exclude ? ' excluded' : ''}`;
      li.dataset.id = a.id;
      const w = (a.bbox[2] - a.bbox[0]).toFixed(0), h = (a.bbox[3] - a.bbox[1]).toFixed(0);
      const swatches = [...(a.styles?.fills || []).map((c) => [c, 'fill']), ...(a.styles?.strokes || []).map((c) => [c, 'stroke'])]
        .map(([c, k]) => `<span class="swatch" title="${k} ${c}" style="background:${c}"></span>`)
        .join('');
      li.innerHTML = `
        <div class="thumb"><img alt="" loading="lazy" src="/api/assets/${encodeURIComponent(a.id)}.svg?v=${ui.version}"></div>
        <div class="meta">
          <input type="text" value="${escapeAttr(a.name)}" aria-label="Asset name" spellcheck="false">
          <div class="sub"><span>${a.kind}</span><span>${w}×${h}pt</span>${swatches}${a.exclude ? '<span>excluded</span>' : ''}</div>
          <div class="sub">
            <a href="/api/assets/${encodeURIComponent(a.id)}.svg?download">SVG</a>
            <a href="/api/assets/${encodeURIComponent(a.id)}.png?download&scale=3">PNG@3x</a>
            ${a.labelText ? `<span title="nearest label">“${escapeAttr(a.labelText)}”</span>` : ''}
          </div>
        </div>`;
      const input = li.querySelector('input');
      input.addEventListener('change', () => mutate('PATCH', `/api/assets/${encodeURIComponent(a.id)}`, { name: input.value }));
      input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
      li.addEventListener('click', (e) => {
        if (e.target.closest('a, input')) return;
        select(a.id, e.shiftKey || e.metaKey || e.ctrlKey);
      });
      return li;
    }),
  );
}

const escapeAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function renderButtons() {
  const n = ui.selected.size;
  $('#mergeBtn').disabled = n < 2;
  $('#splitBtn').disabled = n !== 1;
  $('#excludeBtn').disabled = n === 0;
  $('#deleteBtn').disabled = n === 0;
  $('#prev').disabled = ui.pageNum <= ui.data.pages[0].page;
  $('#next').disabled = ui.pageNum >= ui.data.pages.at(-1).page;
}

function renderAll() {
  drawOverlay();
  renderList();
  renderButtons();
}

function select(id, additive) {
  if (!additive) ui.selected.clear();
  if (ui.selected.has(id) && additive) ui.selected.delete(id);
  else ui.selected.add(id);
  renderAll();
  document.querySelector(`.item[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- overlay interaction

function toPt(e) {
  const r = $('#overlay').getBoundingClientRect();
  const info = pageInfo();
  return [((e.clientX - r.left) / r.width) * info.width, ((e.clientY - r.top) / r.height) * info.height];
}

let drag = null;

$('#overlay').addEventListener('pointerdown', (e) => {
  const t = e.target;
  const [x, y] = toPt(e);
  e.currentTarget.setPointerCapture(e.pointerId);
  if (t.classList.contains('handle')) {
    const a = ui.data.assets.find((q) => q.id === t.dataset.id);
    drag = { mode: 'resize', id: a.id, corner: t.dataset.corner, box: [...a.bbox] };
  } else if (t.classList.contains('box')) {
    select(t.dataset.id, e.shiftKey || e.metaKey || e.ctrlKey);
    drag = null;
  } else {
    drag = { mode: 'draw', x0: x, y0: y, el: svgEl('rect', { class: 'draft', x, y, width: 0, height: 0 }, $('#overlay')) };
  }
});

$('#overlay').addEventListener('pointermove', (e) => {
  if (!drag) return;
  const [x, y] = toPt(e);
  if (drag.mode === 'draw') {
    const b = norm([drag.x0, drag.y0, x, y]);
    Object.entries({ x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1] }).forEach(([k, v]) => drag.el.setAttribute(k, v));
    drag.box = b;
  } else if (drag.mode === 'resize') {
    const b = drag.box;
    if (drag.corner.includes('l')) b[0] = x; else b[2] = x;
    if (drag.corner.includes('t')) b[1] = y; else b[3] = y;
    const a = ui.data.assets.find((q) => q.id === drag.id);
    a.bbox = norm(b);
    drawOverlay();
  }
});

$('#overlay').addEventListener('pointerup', async () => {
  const d = drag;
  drag = null;
  if (!d) return;
  if (d.mode === 'draw') {
    d.el.remove();
    const b = d.box;
    if (!b || b[2] - b[0] < 3 || b[3] - b[1] < 3) {
      ui.selected.clear();
      renderAll();
      return;
    }
    const { count } = await api('POST', '/api/preview-box', { page: ui.pageNum, bbox: b });
    if (!count) return toast('Nothing inside that box');
    const r = await mutate('POST', '/api/assets', { page: ui.pageNum, bbox: b });
    if (r?.asset) select(r.asset.id, false);
    toast(`Added box with ${count} element${count === 1 ? '' : 's'}`);
  } else if (d.mode === 'resize') {
    const a = ui.data.assets.find((q) => q.id === d.id);
    await mutate('PATCH', `/api/assets/${encodeURIComponent(d.id)}`, { bbox: a.bbox });
  }
});

const norm = ([x0, y0, x1, y1]) => [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];

// ---------------------------------------------------------------- actions

async function mergeSelected() {
  if (ui.selected.size < 2) return;
  const r = await mutate('POST', '/api/merge', { ids: [...ui.selected] });
  if (r?.asset) select(r.asset.id, false);
}
async function splitSelected() {
  if (ui.selected.size !== 1) return;
  const r = await mutate('POST', '/api/split', { id: [...ui.selected][0] });
  if (r?.parts) {
    ui.selected = new Set(r.parts.map((p) => p.id));
    renderAll();
    toast(`Split into ${r.parts.length}`);
  }
}
async function excludeSelected() {
  for (const id of ui.selected) {
    const a = ui.data.assets.find((q) => q.id === id);
    await mutate('PATCH', `/api/assets/${encodeURIComponent(id)}`, { exclude: !a.exclude });
  }
}
async function deleteSelected() {
  for (const id of [...ui.selected]) await mutate('DELETE', `/api/assets/${encodeURIComponent(id)}`);
  ui.selected.clear();
  renderAll();
}

$('#mergeBtn').onclick = mergeSelected;
$('#splitBtn').onclick = splitSelected;
$('#excludeBtn').onclick = excludeSelected;
$('#deleteBtn').onclick = deleteSelected;

async function goPage(n) {
  ui.pageNum = n;
  ui.selected.clear();
  await renderPage();
  renderAll();
  fillTuning();
}
// Step through loaded pages (a --pages filter can leave gaps).
const stepPage = (d) => {
  const i = ui.data.pages.findIndex((p) => p.page === ui.pageNum) + d;
  if (i >= 0 && i < ui.data.pages.length) goPage(ui.data.pages[i].page);
};
$('#prev').onclick = () => stepPage(-1);
$('#next').onclick = () => stepPage(1);

const setZoom = async (z) => {
  ui.zoom = z;
  await renderPage();
  drawOverlay();
};
$('#zoomIn').onclick = () => setZoom(effectiveZoom() * 1.25);
$('#zoomOut').onclick = () => setZoom(effectiveZoom() / 1.25);
$('#zoomFit').onclick = () => setZoom(null);

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) return;
  if (e.key === 'm' || e.key === 'M') mergeSelected();
  else if (e.key === 's' || e.key === 'S') splitSelected();
  else if (e.key === 'x' || e.key === 'X') excludeSelected();
  else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  else if (e.key === 'Escape') {
    ui.selected.clear();
    renderAll();
  } else if (e.key === 'ArrowRight') stepPage(1);
  else if (e.key === 'ArrowLeft') stepPage(-1);
});

function fillTuning() {
  const f = $('#tuneForm');
  for (const input of f.querySelectorAll('input')) input.value = ui.data.options[input.name];
}
$('#tuneForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const options = Object.fromEntries([...e.target.querySelectorAll('input')].map((i) => [i.name, Number(i.value)]));
  ui.selected.clear();
  const r = await mutate('POST', '/api/redetect', { page: ui.pageNum, options });
  if (r) toast(`Re-detected: ${pageAssets().length} assets on this page`);
});

$('#exportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const formats = ['svg', 'png'].filter((k) => f.elements[k].checked);
  if (!formats.length) return toast('Pick at least one format');
  $('#exportResult').textContent = 'Exporting…';
  try {
    const r = await api('POST', '/api/export', { formats, scale: Number(f.elements.scale.value), out: f.elements.out.value });
    $('#exportResult').textContent = `${r.count} assets → ${r.out} (contact sheet: _contact-sheet.png)`;
  } catch (err) {
    $('#exportResult').textContent = err.message;
  }
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(async () => {
    if (!ui.zoom) {
      await renderPage();
      drawOverlay();
    }
  }, 150);
});

// ---------------------------------------------------------------- boot

(async function boot() {
  ui.data = await api('GET', '/api/state');
  $('#file').textContent = ui.data.file;
  $('#outDir').value = ui.data.exportDir;
  $('#warnings').innerHTML = [
    ui.data.stale ? '<div>⚠ Source file changed since this session was saved — consider re-detecting.</div>' : '',
    ...ui.data.warnings.map((w) => `<div>⚠ ${escapeAttr(w)}</div>`),
  ].join('');
  ui.pageNum = ui.data.pages[0].page;
  ui.pdf = await pdfjs.getDocument({ url: '/api/source' }).promise;
  await renderPage();
  renderAll();
  fillTuning();
})().catch((e) => toast(`Failed to load: ${e.message}`));
