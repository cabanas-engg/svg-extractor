// Generates a synthetic mockup sheet for tests: rows of icons with OUTLINED
// labels (glyphs drawn as paths, like Illustrator "Create Outlines"), a real-text
// title, a page background, a divider rule, a clip group and a tight-label case.
//
// This is a smoke-test fixture only. The text/icon heuristics still need tuning
// against real AES mockups — synthetic cases are not a substitute.
//
//   node tools/make-fixture.mjs [outDir]
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { loadFont, outlinedText as drawOutlined } from './outline.mjs';

const outDir = process.argv[2] || 'test/fixtures';
fs.mkdirSync(outDir, { recursive: true });

const font = loadFont();

const ORANGE = '#f26b21';
const GRAY = '#6d6e71';

const outlinedText = (doc, text, cx, baseline, size, color = GRAY) => drawOutlined(doc, font, text, cx, baseline, size, color);

function ringIcon(doc, cx, cy, glyph) {
  doc.save();
  doc.lineWidth(3).circle(cx, cy, 30).stroke(ORANGE);
  doc.fillColor(GRAY);
  glyph(cx, cy);
  doc.restore();
}

const doc = new PDFDocument({ size: [792, 612], margin: 0, autoFirstPage: false });
doc.pipe(fs.createWriteStream(path.join(outDir, 'mockup.pdf')));

// ---- page 1: package graphics ----
doc.addPage();
doc.rect(0, 0, 792, 612).fill('#ffffff');
doc.lineWidth(0.5).rect(18, 18, 756, 576).stroke('#cccccc'); // artboard frame
doc.font('Helvetica-Bold').fontSize(18).fillColor('#222222').text('LiftCom Package Graphics', 40, 36);
doc.moveTo(40, 64).lineTo(752, 64).lineWidth(1).stroke('#999999'); // divider rule

const row1 = [
  { label: 'STANDARD', glyph: (x, y) => doc.rect(x - 12, y - 12, 24, 24).fill() },
  { label: 'DELUXE', glyph: (x, y) => doc.polygon([x, y - 16], [x + 15, y + 12], [x - 15, y + 12]).fill() },
  { label: 'PREMIUM', glyph: (x, y) => doc.circle(x, y, 10).fill() },
  // compound glyph: two separated parts that should still cluster as one icon
  { label: 'SIMPLEX 2100', glyph: (x, y) => { doc.rect(x - 14, y - 4, 10, 8).fill(); doc.rect(x + 4, y - 4, 10, 8).fill(); } },
];
row1.forEach((it, i) => {
  const cx = 130 + i * 175, cy = 140;
  ringIcon(doc, cx, cy, it.glyph);
  outlinedText(doc, it.label, cx, cy + 58, 11);
});

// row 2: door diagrams with two-line labels
const row2 = ['LEFT', 'RIGHT', 'REAR'];
row2.forEach((side, i) => {
  const x = 90 + i * 220, y = 270;
  doc.lineWidth(1.5).rect(x, y, 90, 110).stroke(GRAY);
  doc.rect(x + 8, y + 8, 35, 94).fill('#d9d9d9');
  doc.rect(x + 47, y + 8, 35, 94).fill('#d9d9d9');
  // counterweight block, orange
  const cwx = side === 'LEFT' ? x - 18 : side === 'RIGHT' ? x + 98 : x + 30;
  const cwy = side === 'REAR' ? y - 18 : y + 30;
  doc.rect(cwx, cwy, side === 'REAR' ? 30 : 10, side === 'REAR' ? 10 : 50).fill(ORANGE);
  outlinedText(doc, 'COUNTERWEIGHT', x + 45, y + 135, 10);
  outlinedText(doc, `ON THE ${side}`, x + 45, y + 149, 10);
});

// row 3: clip group + a tight label (label touching the icon) + a lone speck
doc.save();
doc.circle(140, 500, 28).clip();
doc.rect(100, 460, 80, 40).fill(ORANGE); // only top half of the circle visible
doc.rect(100, 500, 80, 40).fill(GRAY);
doc.restore();
outlinedText(doc, 'CLIPPED', 140, 545, 10);

doc.lineWidth(2).moveTo(330, 470).lineTo(390, 470).lineTo(390, 520).stroke(GRAY);
outlinedText(doc, 'TIGHT LABEL', 360, 531, 9); // 2pt below geometry: dense case

doc.circle(600, 495, 0.3).fill('#000000'); // speck, should be dropped

// ---- page 2: one icon, real (non-outlined) label ----
doc.addPage();
ringIcon(doc, 396, 280, (x, y) => doc.circle(x, y, 12).fill());
doc.font('Helvetica').fontSize(12).fillColor(GRAY).text('Real Text Label', 346, 330, { width: 100, align: 'center' });

doc.end();
doc.on('end', () => {});
process.on('exit', () => {
  fs.copyFileSync(path.join(outDir, 'mockup.pdf'), path.join(outDir, 'mockup.ai'));
  console.log(`wrote ${outDir}/mockup.pdf and mockup.ai`);
});
