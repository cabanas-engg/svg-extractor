// Export a session's assets as SVG and/or PNG, plus a manifest and a contact
// sheet for eyeballing the whole batch at once.
import fs from 'node:fs';
import path from 'node:path';
import { buildSVG, svgToPNG } from './svg.js';
import { assetElements } from './session.js';

export function cropBox(asset, pad) {
  const [x0, y0, x1, y1] = asset.bbox;
  // Manual boxes are exactly what the user drew; auto boxes get padding.
  const p = asset.kind === 'manual' ? 0 : pad;
  return [x0 - p, y0 - p, x1 + p, y1 + p];
}

/** Render one asset to an SVG string. */
export function renderAssetSVG(page, asset, { pad = 1, idPrefix = '' } = {}) {
  const els = assetElements(page, asset);
  return buildSVG(page, els, cropBox(asset, pad), { idPrefix });
}

/**
 * Build every export file in memory.
 * @param parsed   result of parseFile
 * @param session  session (see session.js)
 * @param opts     { formats: ['svg'|'png'], scale, contactSheet, pad }
 * @returns {{ files: { name: string, data: string|Buffer }[], manifest }}
 */
export function buildExport(parsed, session, opts = {}) {
  const { formats = ['svg'], scale = 3, contactSheet = true } = opts;
  const pad = opts.pad ?? session.options.pad;
  const pages = new Map(parsed.pages.map((p) => [p.page, p]));
  const files = [];
  const written = [];
  const used = new Set();

  for (const asset of session.assets) {
    if (asset.exclude) continue;
    const page = pages.get(asset.page);
    if (!page) continue; // page not loaded (filtered)
    const els = assetElements(page, asset);
    if (!els.length) {
      written.push({ id: asset.id, name: asset.name, skipped: 'no elements inside box' });
      continue;
    }
    const base = asset.name || asset.suggestedName || asset.id;
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);

    const box = cropBox(asset, pad);
    const svg = buildSVG(page, els, box, { idPrefix: `${name}-` });
    const out = {};
    if (formats.includes('svg')) {
      out.svg = `${name}.svg`;
      files.push({ name: out.svg, data: svg });
    }
    if (formats.includes('png')) {
      out.png = `${name}.png`;
      files.push({ name: out.png, data: svgToPNG(svg, { scale }) });
    }
    written.push({
      id: asset.id,
      name,
      page: asset.page,
      kind: asset.kind,
      bbox: box.map((v) => Math.round(v * 100) / 100),
      size: { width: +(box[2] - box[0]).toFixed(2), height: +(box[3] - box[1]).toFixed(2), unit: 'pt' },
      elements: els.length,
      styles: asset.styles,
      label: asset.labelText || null,
      files: out,
      svg, // stripped before writing the manifest
    });
  }

  const manifest = {
    source: session.source,
    exportedAt: new Date().toISOString(),
    formats,
    pngScale: formats.includes('png') ? scale : undefined,
    assets: written.map(({ svg, ...rest }) => rest),
    warnings: parsed.warnings,
  };
  files.push({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) + '\n' });

  if (contactSheet) {
    const sheet = buildContactSheet(written.filter((w) => w.svg));
    files.push({ name: '_contact-sheet.png', data: svgToPNG(sheet, { scale: 1.5, background: '#ffffff', systemFonts: false }) });
  }
  return { files, manifest };
}

/** Build the export and write it to a folder. Returns the manifest. */
export function exportSession(parsed, session, opts) {
  const { files, manifest } = buildExport(parsed, session, opts);
  fs.mkdirSync(opts.out, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(opts.out, f.name), f.data);
  return manifest;
}

// A grid of every exported crop with its name, file and size. This replaces the
// manual "re-render a contact sheet after every attempt" step.
export function buildContactSheet(items, { cols = 6, cell = 140, labelH = 34 } = {}) {
  const rows = Math.ceil(items.length / cols) || 1;
  const W = cols * cell, H = rows * (cell + labelH);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const parts = items.map((it, i) => {
    const x = (i % cols) * cell, y = Math.floor(i / cols) * (cell + labelH);
    const inner = it.svg.replace(
      /^<svg xmlns="[^"]*" width="[^"]*" height="[^"]*"/,
      `<svg x="${x + 10}" y="${y + 10}" width="${cell - 20}" height="${cell - 20}" preserveAspectRatio="xMidYMid meet"`,
    );
    return (
      `<rect x="${x + 4}" y="${y + 4}" width="${cell - 8}" height="${cell - 8}" fill="none" stroke="#e2e2e2" stroke-dasharray="3 3"/>` +
      inner +
      `<text x="${x + cell / 2}" y="${y + cell + 8}" font-family="Helvetica, Arial, sans-serif" font-size="11" text-anchor="middle" fill="#222">${esc(it.name)}</text>` +
      `<text x="${x + cell / 2}" y="${y + cell + 22}" font-family="Helvetica, Arial, sans-serif" font-size="9" text-anchor="middle" fill="#888">p${it.page} · ${it.size.width}×${it.size.height}pt · ${it.kind}</text>`
    );
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#fff"/>${parts.join('')}</svg>`;
}
