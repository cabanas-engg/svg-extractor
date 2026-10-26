// Browser pdf.js. The worker and standard fonts are copied next to the bundle
// by tools/build-web.mjs; the URLs are built from a variable so the bundler
// leaves them pointing at those files.
import * as pdfjs from 'pdfjs-dist/build/pdf.min.mjs';

const workerFile = 'pdf.worker.min.mjs';
const fontDir = 'standard_fonts/';
const cmapDir = 'cmaps/';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(workerFile, import.meta.url).href;

export const standardFontDataUrl = new URL(fontDir, import.meta.url).href;
// Packed cmaps for the page preview. Parsing intentionally omits them so
// detection stays aligned with the Node CLI, which does not load cmaps.
export const cMapUrl = new URL(cmapDir, import.meta.url).href;
export default pdfjs;
