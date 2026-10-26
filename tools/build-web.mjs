// Bundle the review UI into dist/ so it can be hosted with no Node server.
// The CLI and `serve` keep using ui/ directly; this output is only the static app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const pdfjs = path.join(root, 'node_modules', 'pdfjs-dist');

const aliasPlugin = {
  name: 'client-aliases',
  setup(build) {
    const map = {
      './backend.js': path.join(root, 'client', 'backend.js'),
      './pdfjs-setup.js': path.join(root, 'client', 'pdfjs-setup.js'),
    };
    build.onResolve({ filter: /^\.\/(backend|pdfjs-setup)\.js$/ }, (args) => {
      const target = map[args.path];
      if (!target) return null;
      return { path: target };
    });
  },
};

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

await esbuild.build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'ui', 'app.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: path.join(dist, 'app.js'),
  plugins: [aliasPlugin],
  legalComments: 'none',
  logLevel: 'info',
});

const html = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf8')
  .replaceAll('/ui/favicon.svg', 'favicon.svg')
  .replaceAll('/ui/tokens.css', 'tokens.css')
  .replaceAll('/ui/app.css', 'app.css')
  .replaceAll('/ui/app.js', 'app.js');
fs.writeFileSync(path.join(dist, 'index.html'), html);

for (const file of ['app.css', 'tokens.css', 'favicon.svg']) {
  fs.copyFileSync(path.join(root, 'ui', file), path.join(dist, file));
}

fs.copyFileSync(
  path.join(pdfjs, 'build', 'pdf.worker.min.mjs'),
  path.join(dist, 'pdf.worker.min.mjs'),
);
fs.cpSync(path.join(pdfjs, 'standard_fonts'), path.join(dist, 'standard_fonts'), { recursive: true });
fs.cpSync(path.join(pdfjs, 'cmaps'), path.join(dist, 'cmaps'), { recursive: true });
fs.copyFileSync(
  path.join(root, 'node_modules', '@resvg', 'resvg-wasm', 'index_bg.wasm'),
  path.join(dist, 'resvg.wasm'),
);
fs.copyFileSync(
  path.join(pdfjs, 'standard_fonts', 'LiberationSans-Regular.ttf'),
  path.join(dist, 'LiberationSans-Regular.ttf'),
);

const appJs = fs.readFileSync(path.join(dist, 'app.js'), 'utf8');
if (/\bfrom\s+["']node:/.test(appJs)) {
  throw new Error('browser bundle still imports a node: module');
}

console.log(`static app → ${dist}`);
