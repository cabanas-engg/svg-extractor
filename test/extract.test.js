// Regression tests against the synthetic fixture (tools/make-fixture.mjs).
// These pin current behaviour; they do NOT prove the heuristics work on real
// mockups — add real files to test/fixtures/real/ (gitignored) and tune there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFile } from '../src/parse.js';
import { detectPage, findTextRows } from '../src/detect.js';
import { createSession, mergeAssets, splitAsset, addManualAsset, updateAsset } from '../src/session.js';
import { exportSession, renderAssetSVG } from '../src/export.js';

const FIXTURE = new URL('./fixtures/mockup.pdf', import.meta.url).pathname;
const FIXTURE_AI = new URL('./fixtures/mockup.ai', import.meta.url).pathname;
const parsed = await parseFile(FIXTURE);
const page1 = parsed.pages[0];

test('parses .ai (PDF-compatible) the same as .pdf', async () => {
  const ai = await parseFile(FIXTURE_AI);
  assert.equal(ai.pages[0].elements.length, page1.elements.length);
});

test('rejects non-PDF-compatible files with a clear message', async () => {
  const f = path.join(os.tmpdir(), `not-pdf-${process.pid}.ai`);
  fs.writeFileSync(f, '%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator\n');
  await assert.rejects(parseFile(f), /not PDF-compatible/);
  fs.unlinkSync(f);
});

test('detects every icon/diagram on page 1 without label bleed', () => {
  const { assets, labels } = detectPage(page1);
  assert.equal(assets.length, 9);
  // every asset got a label (all labels here sit directly below their icon)
  assert.ok(assets.every((a) => a.labelId), 'each asset has a label');
  // label boxes never overlap their asset's crop
  for (const a of assets) {
    const l = labels.find((x) => x.id === a.labelId);
    assert.ok(l.bbox[1] >= a.bbox[3], `${a.id} crop stops above its label`);
  }
});

test('outlined two-line labels become one label block', () => {
  const { labels } = detectPage(page1);
  const cw = labels.filter((l) => l.bbox[3] - l.bbox[1] > 15 && l.bbox[1] > 380 && l.bbox[1] < 420);
  assert.equal(cw.length, 3, 'COUNTERWEIGHT / ON THE … blocks');
});

test('counterweight blocks stay with their door diagram', () => {
  const { assets } = detectPage(page1);
  const doors = assets.filter((a) => a.row === 2);
  assert.equal(doors.length, 3);
  for (const d of doors) assert.ok(d.styles.fills.includes('#f26b21'), 'orange counterweight included');
});

test('a label 2pt from its geometry is still separated', () => {
  const { assets } = detectPage(page1);
  const corner = assets.find((a) => a.row === 3 && a.col === 2);
  assert.equal(corner.elementIds.length, 1);
});

test('clip groups export with their clip path', () => {
  const { assets } = detectPage(page1);
  const clipped = assets.find((a) => a.row === 3 && a.col === 1);
  const svg = renderAssetSVG(page1, { ...clipped, kind: 'auto' });
  assert.match(svg, /<clipPath /);
  assert.match(svg, /clip-path="url\(#/);
});

test('rows of identical shapes are not mistaken for text', () => {
  const dots = Array.from({ length: 6 }, (_, i) => [i * 6, 0, i * 6 + 4, 4]);
  assert.equal(findTextRows(dots, { maxGlyphHeight: 36, minGlyphs: 3, glyphGap: 0.7, glyphHeightRatio: 2.2, baselineTolerance: 0.2, baselineShare: 0.6 }).length, 0);
});

test('live text labels give names', () => {
  const s = createSession(parsed);
  assert.ok(s.assets.some((a) => a.name === 'real_text_label'));
});

test('merge, split, manual box and export round-trip', () => {
  const s = createSession(parsed);
  const ring = s.assets.filter((a) => a.page === 1 && a.row === 1).slice(0, 2);
  const merged = mergeAssets(s, page1, ring.map((a) => a.id));
  assert.equal(merged.elementIds.length, 4);
  const parts = splitAsset(s, page1, merged.id);
  assert.equal(parts.length, 2);

  const manual = addManualAsset(s, 1, [320, 520, 400, 535], 'Tight Label');
  assert.equal(manual.name, 'tight_label');
  updateAsset(s, parts[0].id, { exclude: true });

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'svgx-'));
  const m = exportSession(parsed, s, { out, formats: ['svg', 'png'], scale: 2 });
  const files = fs.readdirSync(out);
  assert.ok(files.includes('tight_label.svg') && files.includes('tight_label.png'));
  assert.ok(files.includes('_contact-sheet.png') && files.includes('manifest.json'));
  assert.equal(m.assets.length, s.assets.length - 1, 'excluded asset not exported');
  const png = fs.readFileSync(path.join(out, 'tight_label.png'));
  assert.equal(png.readUInt32BE(16), 160, 'PNG width = 80pt × 2');
  fs.rmSync(out, { recursive: true });
});
