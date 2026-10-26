// Node entry: read a PDF-compatible file from disk and parse it with the
// legacy pdf.js build (no worker, no native canvas). The walk itself lives in
// parse-core.js so the browser build can run the same code.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { hasPdfHeader, parseDocument } from './parse-core.js';

export { mul, apply, intersectBox } from './parse-core.js';

const require = createRequire(import.meta.url);
const STANDARD_FONTS = require.resolve('pdfjs-dist/package.json').replace(/package\.json$/, 'standard_fonts/');

/**
 * Parse a file into pages of elements.
 * @returns {Promise<{ file, sha256, numPages, pages: Page[], warnings: string[] }>}
 */
export async function parseFile(file, { pages: pageFilter } = {}) {
  const buf = fs.readFileSync(file);
  if (!hasPdfHeader(buf)) {
    throw new Error(
      `${file} is not PDF-compatible (no %PDF header). If this is an .ai file, re-save it from ` +
        `Illustrator with "Create PDF Compatible File" enabled, or export a PDF.`,
    );
  }
  const doc = await getDocument({
    data: new Uint8Array(buf),
    standardFontDataUrl: STANDARD_FONTS,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;

  try {
    const parsed = await parseDocument(doc, { pages: pageFilter, OPS });
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    return { file, sha256, ...parsed };
  } finally {
    await doc.destroy();
  }
}
