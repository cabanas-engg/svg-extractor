// pdf.js as served by the local Node review server (legacy build, no bundler).
import * as pdfjs from '/pdfjs/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';

export default pdfjs;
