// The review server's file handling: browser uploads, reopening, zip export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/server.js';

const FIXTURE = new URL('./fixtures/mockup.ai', import.meta.url).pathname;
let server, base, workspace;

before(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'svgx-ws-'));
  server = http.createServer(createApp({ workspace }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
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
