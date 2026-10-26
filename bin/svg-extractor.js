#!/usr/bin/env node
// svg-extractor — pull individual icons/diagrams out of an .ai/.pdf mockup sheet.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseFile } from '../src/parse.js';
import { DEFAULTS, classify } from '../src/detect.js';
import { createSession, loadSession, saveSession, defaultSessionPath } from '../src/session.js';
import { exportSession } from '../src/export.js';

const HELP = `svg-extractor — extract icons from Illustrator (.ai) / PDF mockup sheets

Usage:
  svg-extractor detect  <file> [-o session.json] [tuning]   detect assets, write a session
  svg-extractor export  <file> [-o dir] [--format svg,png]  export assets (uses the session if present)
  svg-extractor serve   [file] [--port 5178]                open the review/correct UI
                                                            (no file: upload one from the browser)
  svg-extractor inspect <file>                              element/role counts and warnings

Common options:
  --session <path>   session file (default: <file>.extract.json)
  --pages <list>     e.g. 1,3-5 (default: all)
  --redetect         ignore an existing session and detect from scratch
                     (detect refuses to overwrite a session without it)

Serve options:
  --port <n>         port for the UI (default: 5178)
  --workspace <dir>  where browser uploads are stored (default: ./workspace)

Export options:
  -o, --out <dir>    output directory (default: ./<file-name>-assets)
  --format <list>    svg, png or svg,png (default: svg)
  --scale <n>        PNG scale over native pt size (default: 3)
  --no-contact-sheet skip _contact-sheet.png

Tuning (see DEFAULTS in src/detect.js; all in pt unless noted):
  --gap <n>            geometry closer than this is one asset      (${DEFAULTS.gap})
  --pad <n>            padding around exported crops               (${DEFAULTS.pad})
  --max-glyph-height   tallest shape treated as an outlined glyph  (${DEFAULTS.maxGlyphHeight})
  --set key=value      any other DEFAULTS key, repeatable
`;

function parsePages(s) {
  if (!s) return undefined;
  const out = [];
  for (const part of s.split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m || Number(m[1]) < 1 || (m[2] && Number(m[2]) < Number(m[1]))) throw new Error(`bad --pages entry "${part}" (use e.g. 1,3-5)`);
    for (let i = Number(m[1]); i <= Number(m[2] || m[1]); i++) out.push(i);
  }
  return out;
}

function number(flag, val, { min = 0, exclusive = false } = {}) {
  const n = Number(val);
  if (val === '' || !Number.isFinite(n) || n < min || (exclusive && n === min)) {
    throw new Error(`${flag} must be a number ${exclusive ? '>' : '≥'} ${min} (got "${val}")`);
  }
  return n;
}

function tuning(v) {
  const o = {};
  if (v.gap !== undefined) o.gap = number('--gap', v.gap);
  if (v.pad !== undefined) o.pad = number('--pad', v.pad);
  if (v['max-glyph-height'] !== undefined) o.maxGlyphHeight = number('--max-glyph-height', v['max-glyph-height']);
  for (const kv of v.set || []) {
    const [k, val] = kv.split('=');
    if (!(k in DEFAULTS)) throw new Error(`unknown option --set ${k} (known: ${Object.keys(DEFAULTS).join(', ')})`);
    o[k] = number(`--set ${k}`, val);
  }
  return o;
}

async function main() {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      session: { type: 'string' },
      pages: { type: 'string' },
      format: { type: 'string', default: 'svg' },
      scale: { type: 'string', default: '3' },
      'no-contact-sheet': { type: 'boolean' },
      redetect: { type: 'boolean' },
      port: { type: 'string', default: '5178' },
      workspace: { type: 'string', default: 'workspace' },
      gap: { type: 'string' },
      pad: { type: 'string' },
      'max-glyph-height': { type: 'string' },
      set: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, file] = positionals;
  if (v.help || !cmd || (!file && cmd !== 'serve')) {
    process.stdout.write(HELP);
    process.exit(cmd ? 0 : 1);
  }
  const workspace = path.resolve(v.workspace);
  if (cmd === 'serve' && !file) {
    const { startServer } = await import('../src/server.js');
    await startServer({ workspace, port: number('--port', v.port) });
    return;
  }
  if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);

  const pages = parsePages(v.pages);
  const opts = tuning(v);
  const scale = number('--scale', v.scale, { exclusive: true });
  const port = number('--port', v.port);
  const sessionPath = v.session || defaultSessionPath(file);
  const parsed = await parseFile(file, { pages });
  for (const w of parsed.warnings) console.warn(`warning: ${w}`);

  const getSession = () => {
    if (!v.redetect && fs.existsSync(sessionPath)) {
      const s = loadSession(sessionPath, file);
      if (s.stale) console.warn(`warning: ${file} changed since ${sessionPath} was saved; element ids may not match. Use --redetect.`);
      else console.log(`using session ${sessionPath}`);
      const ignored = Object.keys(opts).filter((k) => k !== 'pad');
      if (ignored.length) console.warn(`warning: ${ignored.join(', ')} ignored: the saved session was detected with its own settings. Use --redetect to apply them.`);
      return { session: s, fromDisk: true };
    }
    return { session: createSession(parsed, opts), fromDisk: false };
  };

  switch (cmd) {
    case 'inspect': {
      for (const p of parsed.pages) {
        const roles = classify(p, { ...DEFAULTS, ...opts });
        const counts = {};
        for (const r of roles.values()) counts[r] = (counts[r] || 0) + 1;
        console.log(`page ${p.page}  ${p.width}×${p.height}pt  ${p.elements.length} elements`, counts);
      }
      break;
    }
    case 'detect': {
      const out = v.out || sessionPath;
      // A session holds hand corrections (merges, drawn boxes, names); don't
      // throw them away without being asked to.
      if (fs.existsSync(out) && !v.redetect) {
        throw new Error(`${out} already exists (it may hold corrections made in the UI). Pass --redetect to replace it.`);
      }
      const session = createSession(parsed, opts);
      saveSession(out, session);
      for (const a of session.assets) {
        console.log(`  p${a.page}  ${a.name.padEnd(28)} ${a.bbox.map((n) => n.toFixed(0)).join(',')}  (${a.elementIds.length} el)`);
      }
      console.log(`${session.assets.length} assets → ${out}`);
      break;
    }
    case 'export': {
      const { session, fromDisk } = getSession();
      if (!fromDisk) saveSession(sessionPath, session);
      const formats = v.format.split(',').map((s) => s.trim().toLowerCase());
      for (const f of formats) if (!['svg', 'png'].includes(f)) throw new Error(`unknown format ${f}`);
      const out = v.out || path.join(process.cwd(), path.basename(file).replace(/\.[^.]+$/, '') + '-assets');
      const m = exportSession(parsed, session, {
        out,
        formats,
        scale,
        pad: opts.pad,
        contactSheet: !v['no-contact-sheet'],
      });
      const ok = m.assets.filter((a) => !a.skipped);
      for (const a of m.assets) if (a.skipped) console.warn(`skipped ${a.name}: ${a.skipped}`);
      console.log(`${ok.length} assets → ${out}${v['no-contact-sheet'] ? '' : ' (see _contact-sheet.png)'}`);
      break;
    }
    case 'serve': {
      const { session, fromDisk } = getSession();
      if (!fromDisk) saveSession(sessionPath, session);
      const { startServer, exportDirFor } = await import('../src/server.js');
      const pagesMap = new Map(parsed.pages.map((p) => [p.page, p]));
      const doc = { file, parsed, session, sessionPath, exportDir: exportDirFor(file), pages: pagesMap };
      await startServer({ doc, workspace, port });
      break;
    }
    default:
      throw new Error(`unknown command ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
