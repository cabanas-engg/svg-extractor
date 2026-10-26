// Node PNG rasteriser (native resvg). The browser build does not import this.
import path from 'node:path';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';

// Scanning system fonts costs seconds per Resvg instance, so it's only done
// for SVGs that carry live text from the source (where the real font matters).
// Everything else gets one bundled font, which is enough for the contact
// sheet's captions.
const require = createRequire(import.meta.url);
const BUNDLED_FONT = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts', 'LiberationSans-Regular.ttf');

/** Rasterise an SVG string. `scale` multiplies the SVG's native (pt) size. */
export function svgToPNG(svg, { scale = 3, background, systemFonts = /<text\b/.test(svg) } = {}) {
  const font = systemFonts
    ? { loadSystemFonts: true, defaultFontFamily: 'Helvetica' }
    : { loadSystemFonts: false, fontFiles: [BUNDLED_FONT], defaultFontFamily: 'Liberation Sans', sansSerifFamily: 'Liberation Sans' };
  const r = new Resvg(svg, { fitTo: { mode: 'zoom', value: scale }, background, font });
  return r.render().asPng();
}
