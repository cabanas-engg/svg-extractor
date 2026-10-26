// CLI argument handling and the guard that keeps `detect` from discarding a
// session's hand corrections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = new URL('../bin/svg-extractor.js', import.meta.url).pathname;
const FIXTURE = new URL('./fixtures/mockup.pdf', import.meta.url).pathname;
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('detect will not overwrite an existing session without --redetect', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svgx-cli-'));
  const session = path.join(dir, 's.json');
  assert.equal(run('detect', FIXTURE, '--session', session).status, 0);
  const edited = fs.readFileSync(session, 'utf8').replace('"p1_r1_c1"', '"hand_named"');
  fs.writeFileSync(session, edited);

  const again = run('detect', FIXTURE, '--session', session);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists.*--redetect/);
  assert.equal(fs.readFileSync(session, 'utf8'), edited, 'corrections kept');

  assert.equal(run('detect', FIXTURE, '--session', session, '--redetect').status, 0);
  assert.doesNotMatch(fs.readFileSync(session, 'utf8'), /hand_named/);
  fs.rmSync(dir, { recursive: true });
});

test('rejects bad numbers and page ranges up front', () => {
  for (const args of [['--gap', 'abc'], ['--set', 'glyphGap='], ['--scale', '0'], ['--pages', '3-1'], ['--pages', 'x']]) {
    const r = run('export', FIXTURE, '-o', os.tmpdir(), ...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /^error: /m, args.join(' '));
  }
});
