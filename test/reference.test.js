// Real-artwork regression: hand-made reference crops laid out on a test sheet
// (tools/eval-reference.mjs). The artwork is customer material and gitignored,
// so this skips unless test/fixtures/real/reference_icons/ is present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluate } from '../tools/eval-reference.mjs';

const REF = new URL('./fixtures/real/reference_icons/', import.meta.url).pathname;

test('reference icons extract intact', { skip: !fs.existsSync(REF) && 'reference SVGs not present' }, async () => {
  const { sheet, results } = await evaluate(REF);
  fs.unlinkSync(sheet);
  const bad = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.assets} assets, ${r.missing} missing ${JSON.stringify(r.missingRoles)}, ${r.extra} extra`);
  assert.deepEqual(bad, []);
  assert.ok(results.every((r) => r.labelled), 'every icon paired with its label');
});
