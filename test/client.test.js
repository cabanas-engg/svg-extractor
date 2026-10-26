// The in-browser document engine, driven with the Node parser and an in-memory
// store. This does not load pdf.js's browser build; browser parity is checked
// by opening the static app (see README).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { File } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { parseFile } from '../src/parse.js';
import { createSession } from '../src/session.js';
import { encodePNG } from '../src/png.js';
import { createEngine } from '../client/engine.js';
import { memoryStorage } from '../client/memory-storage.js';
import { MAX_UPLOAD } from '../src/validate.js';

const FIXTURE = new URL('./fixtures/mockup.pdf', import.meta.url);

async function parseBytes(bytes, fileName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svgx-client-'));
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, bytes);
  try {
    return await parseFile(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const rasterize = async () => encodePNG({ width: 2, height: 2, kind: 2, data: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 0, 0, 255, 255, 255]) });

function engine() {
  return createEngine({ storage: memoryStorage(), parseBytes, rasterize });
}

test('browser engine detects the fixture and round-trips a zip', async () => {
  const bytes = fs.readFileSync(FIXTURE);
  const parsed = await parseFile(FIXTURE.pathname);
  const expected = createSession(parsed);
  const app = engine();

  const opened = await app.upload(new File([bytes], 'mockup.pdf'));
  assert.equal(opened.empty, false);
  assert.equal(opened.client, true);
  assert.equal(opened.file, 'mockup.pdf');
  assert.equal(opened.assets.length, expected.assets.length);
  assert.deepEqual(opened.assets.map((a) => a.name), expected.assets.map((a) => a.name));
  assert.ok(opened.recent.length === 1 && opened.recent[0].assets === opened.assets.length);

  const again = await app.upload(new File([bytes], 'mockup.pdf'));
  assert.equal(again.file, 'mockup.pdf');
  assert.equal(again.recent.length, 1, 'identical bytes reuse the saved file');

  const renamed = await app.patchAsset(opened.assets[0].id, { name: 'Renamed Icon' });
  assert.equal(renamed.assets.find((a) => a.id === opened.assets[0].id).name, 'renamed_icon');
  assert.equal(renamed.canUndo, true);
  const undone = await app.undo();
  assert.equal(undone.assets[0].name, expected.assets[0].name);

  const { files } = await app.exportFiles({ formats: ['svg', 'png'], scale: 2 });
  const names = files.map((f) => f.name);
  assert.ok(names.includes('manifest.json') && names.includes('_contact-sheet.png'));
  assert.equal(names.filter((n) => n.endsWith('.svg')).length, expected.assets.length);
  assert.equal(names.filter((n) => n.endsWith('.png')).length, expected.assets.length + 1);

  const { zip } = await import('../src/zip.js');
  const zipped = zip(files);
  const out = path.join(os.tmpdir(), `svgx-client-${process.pid}.zip`);
  fs.writeFileSync(out, zipped);
  const listing = execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(z.namelist()))', out]).toString();
  assert.ok(listing.includes('manifest.json'));
  fs.unlinkSync(out);

  const reopened = await app.open('mockup.pdf');
  assert.equal(reopened.assets[0].name, expected.assets[0].name, 'saved session survived reopen');
});

test('browser engine rejects files that are not PDF-compatible or are too large', async () => {
  const app = engine();
  await assert.rejects(
    app.upload(new File([Buffer.from('%!PS-Adobe-3.0\n')], 'legacy.ai')),
    /PDF Compatible/,
  );
  const huge = { name: 'huge.pdf', size: MAX_UPLOAD + 1, arrayBuffer: () => { throw new Error('should not read'); } };
  await assert.rejects(app.upload(huge), /too large/);
  await assert.rejects(app.open('../package.json'), /not in the workspace/);
});

test('static bundle builds without Node imports', async () => {
  const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync('node', ['tools/build-web.mjs'], { cwd: repo, stdio: 'inherit' });
  const dist = path.join(repo, 'dist');
  for (const f of ['index.html', 'app.js', 'app.css', 'tokens.css', 'pdf.worker.min.mjs', 'resvg.wasm', 'LiberationSans-Regular.ttf']) {
    assert.ok(fs.existsSync(path.join(dist, f)), f);
  }
  assert.ok(fs.existsSync(path.join(dist, 'standard_fonts', 'LiberationSans-Regular.ttf')));
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.match(html, /src="app\.js"/);
  assert.doesNotMatch(html, /\/ui\/app\.js/);
  const js = fs.readFileSync(path.join(dist, 'app.js'), 'utf8');
  assert.doesNotMatch(js, /from\s+["']node:/);
});
