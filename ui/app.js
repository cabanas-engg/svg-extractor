// Review/correct UI. The page itself is rendered by PDF.js (ground truth: what
// the file really looks like); boxes are an SVG overlay in the same pt
// coordinate space the extractor uses. Thumbnails in the sidebar are the actual
// exported SVGs, so a bad crop is visible before export.
import * as pdfjs from '/pdfjs/pdf.mjs';
import { icon, hydrateIcons } from '/ui/icons.js';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';
hydrateIcons();

const $ = (s) => document.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';

const ui = {
  data: null,
  pdf: null,
  pageNum: 1,
  zoom: null, // null = fit width
  selected: new Set(),
  scope: 'page', // sidebar list: 'page' | 'all'
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
// A page's assets in reading order (rows by vertical overlap, then left to right).
function pageAssets(pageNum = ui.pageNum) {
  const rows = [];
  for (const a of ui.data.assets.filter((x) => x.page === pageNum).sort((p, q) => p.bbox[1] - q.bbox[1])) {
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
  const pad = parseFloat(getComputedStyle(stage).paddingLeft) * 2 + 2;
  return Math.max(0.2, (stage.clientWidth - pad) / pageInfo().width);
}

async function renderPage() {
  const info = pageInfo();
  const zoom = effectiveZoom();
  $('#zoomLabel').textContent = `${Math.round(zoom * 100)}%`;
  $('#pageLabel').textContent = `Page ${ui.pageNum} of ${ui.data.pages.length}`;
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
    const state = ui.selected.has(a.id) ? 'selected' : a.exclude ? 'excluded' : a.kind === 'manual' ? 'manual' : '';
    const cls = ['box', a.kind, a.exclude ? 'excluded' : '', ui.selected.has(a.id) ? 'selected' : ''].join(' ');
    const r = svgEl('rect', { class: cls, x: x0, y: y0, width: x1 - x0, height: y1 - y0, 'data-id': a.id }, svg);
    svgEl('title', {}, r).textContent = a.name;
    // name pill above the box, constant on-screen size (mono ≈ 0.6em per char);
    // zoomed far out they'd bury the artwork, so the list carries the names
    if (zoom < 0.5) continue;
    const fs = 9 / zoom, padX = 4 / zoom, h = 13 / zoom;
    svgEl('rect', { class: `tag-bg ${state}`, x: x0, y: y0 - h, width: a.name.length * fs * 0.6 + padX * 2, height: h, rx: 2 / zoom }, svg);
    const tag = svgEl('text', { class: 'tag', x: x0 + padX, y: y0 - h / 2, 'font-size': fs, 'dominant-baseline': 'central' }, svg);
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

function assetItem(a) {
  const li = document.createElement('li');
  li.className = `item${ui.selected.has(a.id) ? ' selected' : ''}${a.exclude ? ' excluded' : ''}`;
  li.dataset.id = a.id;
  const w = (a.bbox[2] - a.bbox[0]).toFixed(0), h = (a.bbox[3] - a.bbox[1]).toFixed(0);
  const swatches = [...(a.styles?.fills || []).map((c) => [c, 'fill']), ...(a.styles?.strokes || []).map((c) => [c, 'stroke'])]
    .map(([c, k]) => `<span class="swatch" title="${k} ${c}" style="background:${c}"></span>`)
    .join('');
  const id = encodeURIComponent(a.id);
  const kind = a.exclude ? '<span class="badge excluded">excluded</span>' : `<span class="badge ${a.kind === 'manual' ? 'manual' : ''}">${a.kind === 'manual' ? 'hand-drawn' : a.kind}</span>`;
  li.innerHTML = `
    <div class="thumb"><img alt="" loading="lazy" src="/api/assets/${id}.svg?v=${ui.version}"></div>
    <div class="meta">
      <input type="text" value="${escapeAttr(a.name)}" aria-label="Asset name" spellcheck="false">
      <div class="row">${kind}<span class="mono">${w}×${h}pt</span>${swatches}</div>
      <div class="row">
        <a class="dl" href="/api/assets/${id}.svg?download" data-icon-slot>SVG</a>
        <a class="dl" href="/api/assets/${id}.png?download&scale=3" data-icon-slot>PNG@3x</a>
        ${a.labelText ? `<span class="badge label" title="nearest label">${escapeAttr(a.labelText)}</span>` : ''}
      </div>
    </div>`;
  for (const dl of li.querySelectorAll('[data-icon-slot]')) dl.prepend(icon('download'));
  const input = li.querySelector('input');
  input.addEventListener('change', () => mutate('PATCH', `/api/assets/${id}`, { name: input.value }));
  input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
  li.addEventListener('click', async (e) => {
    if (e.target.closest('a, input')) return;
    if (a.page !== ui.pageNum) await goPage(a.page);
    select(a.id, e.shiftKey || e.metaKey || e.ctrlKey);
  });
  return li;
}

function renderList() {
  const list = $('#list');
  const pages = ui.scope === 'all' ? ui.data.pages.map((p) => p.page) : [ui.pageNum];
  const nodes = [];
  for (const n of pages) {
    const assets = pageAssets(n);
    if (ui.scope === 'all' && assets.length) {
      const h = document.createElement('li');
      h.className = 'page-heading';
      h.textContent = `Page ${n} · ${assets.length}`;
      nodes.push(h);
    }
    nodes.push(...assets.map(assetItem));
  }
  if (!nodes.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No assets on this page. Drag on the page to draw one, or adjust Tuning and re-detect.';
    nodes.push(li);
  }
  list.replaceChildren(...nodes);
  const included = ui.data.assets.filter((a) => !a.exclude).length;
  $('#count').textContent = `${included}/${ui.data.assets.length} to export`;
}

function renderStats() {
  const on = ui.data.assets.filter((a) => a.page === ui.pageNum);
  const stats = [
    ['assets', 'shapes', on.length, 'Assets on this page'],
    ['manual', 'square-dashed-mouse-pointer', on.filter((a) => a.kind === 'manual').length, 'Hand-drawn boxes'],
    ['excluded', 'eye-off', on.filter((a) => a.exclude).length, 'Excluded from export'],
    ['labels', 'tag', ui.data.labels.filter((l) => l.page === ui.pageNum).length, 'Text labels found'],
  ];
  $('#stats').replaceChildren(
    ...stats.map(([cls, ic, n, title]) => {
      const s = document.createElement('span');
      s.className = `stat ${cls}`;
      s.title = title;
      s.append(icon(ic), String(n));
      return s;
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
  $('#undoBtn').disabled = !ui.data.canUndo;
  $('#redoBtn').disabled = !ui.data.canRedo;
  $('#prev').disabled = ui.pageNum <= ui.data.pages[0].page;
  $('#next').disabled = ui.pageNum >= ui.data.pages.at(-1).page;
}

function renderAll() {
  drawOverlay();
  renderList();
  renderStats();
  renderButtons();
}

function select(id, additive) {
  if (!additive) ui.selected.clear();
  if (ui.selected.has(id) && additive) ui.selected.delete(id);
  else ui.selected.add(id);
  renderAll();
  document.querySelector(`.item[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  document.querySelector(`#overlay .box[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
    drag = { mode: 'resize', id: a.id, corner: t.dataset.corner, box: [...a.bbox], start: [...a.bbox] };
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
    const n = norm(b);
    // never collapse a box to nothing (the server rejects zero-size boxes)
    if (n[2] - n[0] >= 1 && n[3] - n[1] >= 1) a.bbox = n;
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
    // A click on a handle without dragging must not turn an auto box into a
    // hand-drawn one.
    if (a.bbox.every((v, i) => Math.abs(v - d.start[i]) < 0.01)) return;
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
// One request per action, so one undo step reverses it.
async function excludeSelected() {
  if (!ui.selected.size) return;
  const sel = ui.data.assets.filter((a) => ui.selected.has(a.id));
  // mixed selection: exclude all; all excluded already: include them again
  await mutate('POST', '/api/exclude', { ids: sel.map((a) => a.id), exclude: !sel.every((a) => a.exclude) });
}
async function deleteSelected() {
  if (!ui.selected.size) return;
  const n = ui.selected.size;
  if (await mutate('POST', '/api/delete', { ids: [...ui.selected] })) toast(`Deleted ${n} asset${n === 1 ? '' : 's'} · Ctrl/⌘ Z to undo`);
}
async function undo(dir = 'undo') {
  if (!ui.data.canUndo && dir === 'undo') return;
  if (!ui.data.canRedo && dir === 'redo') return;
  await mutate('POST', `/api/${dir}`);
}

$('#mergeBtn').onclick = mergeSelected;
$('#splitBtn').onclick = splitSelected;
$('#excludeBtn').onclick = excludeSelected;
$('#deleteBtn').onclick = deleteSelected;
$('#undoBtn').onclick = () => undo('undo');
$('#redoBtn').onclick = () => undo('redo');

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
$('#zoomLabel').onclick = () => setZoom(null);

// ---------------------------------------------------------------- chrome: theme, sidebar, tabs, popover, dialog

function renderThemeToggle() {
  const dark = document.documentElement.classList.contains('dark');
  $('#themeToggle').replaceChildren(icon(dark ? 'sun' : 'moon'));
}
$('#themeToggle').onclick = () => {
  const dark = document.documentElement.classList.toggle('dark');
  try {
    localStorage.setItem('svgx-theme', dark ? 'dark' : 'light');
  } catch {}
  renderThemeToggle();
};
renderThemeToggle();

async function setSidebar(open) {
  $('#app').classList.toggle('collapsed', !open);
  $('#expandBtn').hidden = open;
  $('#topbarBrand').hidden = open;
  if (!ui.zoom && ui.pdf) {
    await renderPage();
    drawOverlay();
  }
}
$('#collapseBtn').onclick = () => setSidebar(false);
$('#expandBtn').onclick = () => setSidebar(true);

for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => {
    ui.scope = tab.dataset.scope;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    renderList();
  };
}

const tune = $('#tuneForm');
$('#tuneBtn').onclick = (e) => {
  e.stopPropagation();
  tune.hidden = !tune.hidden;
  $('#tuneBtn').classList.toggle('open', !tune.hidden);
};
document.addEventListener('pointerdown', (e) => {
  if (!tune.hidden && !e.target.closest('.popover-wrap')) {
    tune.hidden = true;
    $('#tuneBtn').classList.remove('open');
  }
  if (!$('#openMenu').hidden && !e.target.closest('.popover-wrap')) $('#openMenu').hidden = true;
});

const exportDialog = $('#exportDialog');
function openExport() {
  if (ui.data.empty) return;
  const included = ui.data.assets.filter((a) => !a.exclude).length;
  $('#exportSummary').textContent = `${included} of ${ui.data.assets.length} assets will be exported, plus manifest.json and a contact sheet.`;
  $('#exportResult').textContent = '';
  exportDialog.showModal();
}
$('#exportOpen').onclick = openExport;
$('#exportClose').onclick = () => exportDialog.close();
$('#exportCancel').onclick = () => exportDialog.close();

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || exportDialog.open) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && ui.data?.empty === false && (e.key === 'z' || e.key === 'Z' || (e.key === 'y' && e.ctrlKey))) {
    e.preventDefault();
    return undo(e.shiftKey || e.key === 'y' ? 'redo' : 'undo');
  }
  if (mod || e.altKey) return;
  if (e.key === 'Escape' && (!tune.hidden || !$('#openMenu').hidden)) {
    tune.hidden = true;
    $('#tuneBtn').classList.remove('open');
    $('#openMenu').hidden = true;
    return;
  }
  if (e.key === 'o' || e.key === 'O') return $('#fileInput').click();
  if (ui.data?.empty !== false) return;
  if (e.key === 'e' || e.key === 'E') openExport();
  else if (e.key === 'm' || e.key === 'M') mergeSelected();
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
  if (r) {
    tune.hidden = true;
    $('#tuneBtn').classList.remove('open');
    toast(`Re-detected: ${pageAssets().length} assets on this page`);
  }
});

function exportOptions() {
  const f = $('#exportForm');
  const formats = ['svg', 'png'].filter((k) => f.elements[k].checked);
  if (!formats.length) {
    $('#exportResult').textContent = 'Pick at least one format.';
    return null;
  }
  return { formats, scale: Number(f.elements.scale.value) || 3, out: f.elements.out.value };
}

// Download: a plain GET so the browser streams it like any other download.
$('#exportForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const o = exportOptions();
  if (!o) return;
  const a = document.createElement('a');
  a.href = `/api/export.zip?formats=${o.formats.join(',')}&scale=${o.scale}`;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
  $('#exportResult').textContent = 'Preparing the .zip; your browser will download it in a moment.';
});

$('#exportFolder').onclick = async () => {
  const o = exportOptions();
  if (!o) return;
  $('#exportResult').textContent = 'Exporting…';
  try {
    const r = await api('POST', '/api/export', o);
    $('#exportResult').textContent = `${r.count} assets → ${r.out} (contact sheet: _contact-sheet.png)`;
  } catch (err) {
    $('#exportResult').textContent = err.message;
  }
};

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(async () => {
    if (!ui.zoom && ui.data && !ui.data.empty) {
      await renderPage();
      drawOverlay();
    }
  }, 150);
});

// ---------------------------------------------------------------- opening files

const busy = (text) => {
  $('#busy').hidden = !text;
  if (text) $('#busyText').textContent = text;
};
const fmtSize = (b) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
function fmtAgo(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  return new Date(ms).toLocaleDateString();
}

function recentItems() {
  return ui.data.recent.map((r) => {
    const b = document.createElement('button');
    b.className = `menu-item${r.name === ui.data.file ? ' current' : ''}`;
    const name = document.createElement('span');
    name.className = 'grow';
    name.textContent = r.name;
    const meta = document.createElement('span');
    meta.className = 'meta-r';
    meta.textContent = `${r.assets != null ? `${r.assets} assets · ` : ''}${fmtAgo(r.modified)}`;
    b.title = `Open ${r.name} (${fmtSize(r.size)})`;
    b.append(icon('file-image'), name, meta);
    b.onclick = () => openRecent(r.name);
    return b;
  });
}

function renderRecent() {
  const items = recentItems();
  $('#recentBlock').hidden = !items.length;
  $('#recentList').replaceChildren(...items);
  const menu = recentItems();
  if (!menu.length) {
    const p = document.createElement('div');
    p.className = 'menu-empty';
    p.textContent = 'Nothing uploaded yet.';
    menu.push(p);
  }
  $('#recentMenu').replaceChildren(...menu);
  $('#uploadNote').textContent = `Up to ${Math.round(ui.data.maxUpload / 1024 / 1024)} MB. Files stay on this computer, in ${ui.data.workspace}`;
}

function showError(msg) {
  const el = $('#dropError');
  el.textContent = msg;
  el.hidden = !msg;
  if (msg) toast(msg);
}

async function uploadFile(file) {
  if (!file) return;
  $('#openMenu').hidden = true;
  showError('');
  if (!/\.(ai|pdf)$/i.test(file.name)) return showError(`${file.name}: choose an .ai or .pdf file.`);
  if (file.size > ui.data.maxUpload) return showError(`${file.name} is ${fmtSize(file.size)}; the limit is ${fmtSize(ui.data.maxUpload)}.`);
  busy(`Uploading and analysing ${file.name}…`);
  try {
    const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    ui.data = json;
    await showDocument();
    toast(`Opened ${ui.data.file}: ${ui.data.assets.length} assets found`);
  } catch (e) {
    showError(e.message);
  } finally {
    busy(null);
    $('#fileInput').value = '';
  }
}

async function openRecent(name) {
  $('#openMenu').hidden = true;
  busy(`Opening ${name}…`);
  try {
    ui.data = await api('POST', '/api/open', { name });
    await showDocument();
  } catch (e) {
    showError(e.message);
  } finally {
    busy(null);
  }
}

$('#openBtn').onclick = (e) => {
  e.stopPropagation();
  renderRecent();
  $('#openMenu').hidden = !$('#openMenu').hidden;
};
$('#uploadItem').onclick = () => $('#fileInput').click();
$('#chooseBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => uploadFile(e.target.files[0]);

// Drag a file anywhere onto the window.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (++dragDepth === 1) $('#dropOverlay').hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('#dropOverlay').hidden = true;
  }
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').hidden = true;
  const files = [...e.dataTransfer.files];
  if (files.length > 1) toast('One file at a time; opening the first.');
  uploadFile(files[0]);
});

function showStart() {
  $('#app').classList.add('no-doc');
  $('#start').hidden = false;
  $('#fileChip').hidden = true;
  $('#exportOpen').disabled = true;
  $('#warnings').innerHTML = '';
  $('#list').replaceChildren(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No file open yet. Upload an .ai or PDF to start.' }));
  $('#count').textContent = '';
  $('#stats').replaceChildren();
  for (const id of ['#mergeBtn', '#splitBtn', '#excludeBtn', '#deleteBtn', '#undoBtn', '#redoBtn']) $(id).disabled = true;
  renderRecent();
}

async function showDocument() {
  if (ui.data.empty) return showStart();
  $('#app').classList.remove('no-doc');
  $('#start').hidden = true;
  $('#fileChip').hidden = false;
  $('#exportOpen').disabled = false;
  $('#file').textContent = ui.data.file;
  $('#outDir').value = ui.data.exportDir;
  $('#warnings').innerHTML = [
    ui.data.stale ? '<div>⚠ Source file changed since this session was saved; consider re-detecting.</div>' : '',
    ...ui.data.warnings.map((w) => `<div>⚠ ${escapeAttr(w)}</div>`),
  ].join('');
  ui.selected.clear();
  ui.version++;
  ui.zoom = null;
  ui.pageNum = ui.data.pages[0].page;
  ui.renderTask?.cancel();
  await ui.pdf?.destroy();
  // cache-buster: the URL is the same for every file
  ui.pdf = await pdfjs.getDocument({ url: `/api/source?v=${Date.now()}` }).promise;
  await renderPage();
  renderAll();
  fillTuning();
  renderRecent();
}

// ---------------------------------------------------------------- boot

(async function boot() {
  ui.data = await api('GET', '/api/state');
  await showDocument();
})().catch((e) => toast(`Failed to load: ${e.message}`));
