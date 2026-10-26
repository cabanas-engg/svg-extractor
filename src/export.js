// Node export: rasterise with resvg-js and write the files to a folder.
import fs from 'node:fs';
import path from 'node:path';
import { svgToPNG } from './svg-png.js';
import { buildExport as assemble, cropBox, renderAssetSVG, buildContactSheet } from './export-core.js';

export { cropBox, renderAssetSVG, buildContactSheet };

/** Build every export file in memory. Returns a Promise. */
export function buildExport(parsed, session, opts) {
  return assemble(parsed, session, opts, svgToPNG);
}

/** Build the export and write it to a folder. Returns the manifest. */
export async function exportSession(parsed, session, opts) {
  const { files, manifest } = await buildExport(parsed, session, opts);
  fs.mkdirSync(opts.out, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(opts.out, f.name), f.data);
  return manifest;
}
