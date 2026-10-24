// Draw text as outlined glyph paths into a pdfkit document — the equivalent
// of Illustrator's "Create Outlines" — for building test sheets.
//
// Glyph commands go to pdfkit's path API directly. Don't round-trip them
// through doc.path(svgString): pdfkit's SVG path parser silently truncates
// some opentype.js output (it dropped most of an "S"), which then looks like
// an extractor bug.
import fs from 'node:fs';
import opentype from 'opentype.js';

export const FONT = '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf';

export function loadFont(file = FONT) {
  return opentype.parse(fs.readFileSync(file).buffer);
}

function drawGlyph(doc, glyphPath) {
  let any = false;
  for (const c of glyphPath.commands) {
    if (c.type === 'M') doc.moveTo(c.x, c.y);
    else if (c.type === 'L') doc.lineTo(c.x, c.y);
    else if (c.type === 'Q') doc.quadraticCurveTo(c.x1, c.y1, c.x, c.y);
    else if (c.type === 'C') doc.bezierCurveTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y);
    else if (c.type === 'Z') doc.closePath();
    any = true;
  }
  return any;
}

/** One filled path per glyph, horizontally centred on cx. */
export function outlinedText(doc, font, text, cx, baseline, size, color) {
  const width = font.getAdvanceWidth(text, size);
  for (const g of font.getPaths(text, cx - width / 2, baseline, size)) {
    if (drawGlyph(doc, g)) doc.fill(color);
  }
}
