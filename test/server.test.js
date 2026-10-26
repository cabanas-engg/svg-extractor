// The review server's file handling: browser uploads, reopening, zip export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createApp, startServer } from '../src/server.js';

const FIXTURE = new URL('./fixtures/mockup.ai', import.meta.url).pathname;
let server, base, workspace;

before(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'svgx-ws-'));
  server = http.createServer(createApp({ workspace }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // On Node < 20 a top-level after() only runs once the event loop is idle,
  // which a listening server prevents; unref() breaks that deadlock.
  server.unref();
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  // fetch keeps connections alive, and close() waits for them on Node < 19
  server.closeAllConnections();
  server.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

const upload = (name, data) => fetch(`${base}/api/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body: data });

test('starts with no file open', async () => {
  const s = await (await fetch(`${base}/api/state`)).json();
  assert.equal(s.empty, true);
  assert.deepEqual(s.recent, []);
  assert.equal((await fetch(`${base}/api/source`)).status, 409);
});

test('uploading a PDF-compatible .ai opens it and detects assets', async () => {
  const res = await upload('LiftCom Mockup (Outlined).ai', fs.readFileSync(FIXTURE));
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.empty, false);
  assert.equal(s.file, 'LiftCom_Mockup_Outlined.ai');
  assert.equal(s.assets.length, 10);
  assert.ok(fs.existsSync(path.join(workspace, 'LiftCom_Mockup_Outlined.ai.extract.json')), 'session saved next to the upload');
  assert.equal((await fetch(`${base}/api/source`)).status, 200);
});

test('re-uploading identical bytes reuses the file and its session', async () => {
  const s = await (await upload('LiftCom Mockup (Outlined).ai', fs.readFileSync(FIXTURE))).json();
  assert.equal(s.file, 'LiftCom_Mockup_Outlined.ai');
  assert.equal(s.recent.length, 1);
});

test('rejects files that are not PDF-compatible', async () => {
  const res = await upload('legacy.ai', Buffer.from('%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator\n'));
  assert.equal(res.status, 415);
  assert.match((await res.json()).error, /PDF Compatible/);
  assert.equal(fs.readdirSync(workspace).filter((f) => f.startsWith('.upload-')).length, 0, 'temp file cleaned up');
  // the open document is untouched
  assert.equal((await (await fetch(`${base}/api/state`)).json()).file, 'LiftCom_Mockup_Outlined.ai');
});

test('reopens a file from the workspace', async () => {
  const res = await fetch(`${base}/api/open`, { method: 'POST', body: JSON.stringify({ name: 'LiftCom_Mockup_Outlined.ai' }) });
  assert.equal(res.status, 200);
  const bad = await fetch(`${base}/api/open`, { method: 'POST', body: JSON.stringify({ name: '../package.json' }) });
  assert.equal(bad.status, 404);
});

test('exports everything as a valid zip', async () => {
  const res = await fetch(`${base}/api/export.zip?formats=svg,png&scale=2`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /LiftCom_Mockup_Outlined-assets\.zip/);
  const file = path.join(workspace, 'out.zip');
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const listing = execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(z.namelist()))', file]).toString();
  const names = listing.trim().split('\n');
  assert.ok(names.includes('manifest.json') && names.includes('_contact-sheet.png'));
  assert.equal(names.filter((n) => n.endsWith('.svg')).length, 10);
  assert.equal(names.filter((n) => n.endsWith('.png')).length, 11, '10 assets + contact sheet');
});

const post = (url, body, headers = {}) =>
  fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const state = async () => (await fetch(`${base}/api/state`)).json();

test('undo and redo step through edits', async () => {
  const before = await state();
  assert.equal(before.canUndo, false);
  const ids = before.assets.slice(0, 3).map((a) => a.id);
  let s = await (await post('/api/delete', { ids })).json();
  assert.equal(s.assets.length, before.assets.length - 3);
  assert.equal(s.canUndo, true);

  s = await (await post('/api/undo')).json();
  assert.deepEqual(s.assets.map((a) => a.id), before.assets.map((a) => a.id), 'one undo restores the whole batch');
  assert.equal(s.canRedo, true);
  const saved = JSON.parse(fs.readFileSync(path.join(workspace, 'LiftCom_Mockup_Outlined.ai.extract.json'), 'utf8'));
  assert.equal(saved.assets.length, before.assets.length, 'undo is saved to the session file');

  s = await (await post('/api/redo')).json();
  assert.equal(s.assets.length, before.assets.length - 3);
  assert.equal((await post('/api/redo')).status, 409, 'nothing left to redo');
  await post('/api/undo');
});

test('a failed edit changes nothing and adds no undo step', async () => {
  const before = await state();
  const res = await post('/api/redetect', { page: 1, options: { gap: '' } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /gap/);
  const after = await state();
  assert.equal(after.options.gap, before.options.gap);
  assert.equal(after.canRedo, before.canRedo, 'redo stack untouched');
  assert.equal((await post('/api/redetect', { page: 1, options: { nope: 1 } })).status, 400);
  assert.equal((await post('/api/merge', { ids: 'x' })).status, 400);
  assert.equal((await post('/api/assets', { page: 1, bbox: [10, 10, 10, 20] })).status, 400);
});

test('refuses cross-site writes and foreign Host headers', async () => {
  const evil = await post('/api/export', { out: path.join(workspace, 'evil') }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(fs.existsSync(path.join(workspace, 'evil')), false);
  const same = await post('/api/undo', {}, { origin: base });
  assert.notEqual(same.status, 403, 'same-origin requests from the UI are allowed');
  // DNS rebinding: a hostile domain resolving to 127.0.0.1
  const status = await new Promise((resolve, reject) => {
    http.get(`${base}/api/state`, { headers: { host: 'evil.example' } }, (r) => resolve(r.statusCode)).on('error', reject);
  });
  assert.equal(status, 403);
});

test('rejects out-of-range PNG scales', async () => {
  const id = (await state()).assets[0].id;
  assert.equal((await fetch(`${base}/api/assets/${id}.png?scale=500`)).status, 400);
  assert.equal((await fetch(`${base}/api/export.zip?scale=abc`)).status, 400);
  assert.equal((await fetch(`${base}/api/export.zip?formats=gif`)).status, 400);
  const png = await fetch(`${base}/api/assets/${id}.png?scale=2&download`);
  assert.equal(png.status, 200);
  assert.match(png.headers.get('content-disposition'), /filename\*=UTF-8''/);
});

test('an unreadable upload is not left in the workspace', async () => {
  const res = await upload('broken.pdf', Buffer.from('%PDF-1.7\nthis is not really a pdf\n'));
  assert.equal(res.status, 422);
  assert.equal(fs.existsSync(path.join(workspace, 'broken.pdf')), false);
  assert.ok(!(await state()).recent.some((r) => r.name === 'broken.pdf'));
});

test('keyed thumbnail URLs are cacheable, plain ones are not', async () => {
  const s = await state();
  assert.ok(s.docId, 'state carries a document id for cache keys');
  const id = s.assets[0].id;
  assert.match((await fetch(`${base}/api/assets/${id}.svg?k=abc`)).headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(`${base}/api/assets/${id}.svg`)).headers.get('cache-control'), 'no-store');
});

test('a busy port gives a clear error', async () => {
  const port = server.address().port;
  await assert.rejects(startServer({ workspace, port }), /port \d+ is already in use.*--port/);
});
