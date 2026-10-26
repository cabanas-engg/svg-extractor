# svg-extractor

Pull individual icons and diagrams out of an Illustrator (`.ai`) or PDF mockup
sheet as clean, standalone SVG (and PNG) files. No hand-measured crop
coordinates: elements are clustered by proximity, and outlined label text is
detected and kept out of the crops.

`.ai` files must be saved with **Create PDF Compatible File** (Illustrator's
default). Works best on outlined/flattened artwork.

## Install

```sh
npm install
```

Node 20+. No native dependencies beyond the prebuilt `@resvg/resvg-js` binary.

## Use

The easiest way is the browser UI. Start it without a file and upload one:

```sh
npm run serve                                   # starts the UI and opens your browser
node bin/svg-extractor.js serve                 # same, without opening it: http://127.0.0.1:5178
```

Drag an `.ai` or PDF onto the page, or click **Choose file**. Uploads are saved
in `./workspace/` (change with `--workspace <dir>`), each with its own session,
so you can reopen them later from **Open file → Recent**. When you're done,
**Export → Download .zip** gives you every SVG/PNG plus the manifest and
contact sheet.

From the command line:

```sh
# one shot: detect + export SVGs (+ manifest.json, _contact-sheet.png)
node bin/svg-extractor.js export sheet.ai -o icons/

# SVG and PNG at 4x
node bin/svg-extractor.js export sheet.ai -o icons/ --format svg,png --scale 4

# review a file on disk in the browser (no upload needed)
node bin/svg-extractor.js serve sheet.ai        # http://127.0.0.1:5178

# just detect (writes sheet.ai.extract.json) / see what the parser found
node bin/svg-extractor.js detect sheet.ai
node bin/svg-extractor.js inspect sheet.ai
```

Corrections made in the UI are saved to `<file>.extract.json`, and `export`
picks that session up automatically. Pass `--redetect` to start over;
`detect` refuses to overwrite an existing session without it, so corrections
aren't lost by accident.

### Tuning

Thresholds live in `DEFAULTS` in `src/detect.js`. The common ones:

| flag | default | meaning |
| --- | --- | --- |
| `--gap` | 10 | geometry closer than this (pt) is one asset |
| `--pad` | 1 | padding (pt) around each crop |
| `--max-glyph-height` | 36 | taller shapes are never treated as outlined text |
| `--set key=value` | | any other `DEFAULTS` key, e.g. `--set glyphGap=0.9` |

The same knobs are under **Tuning** in the UI, with per-page re-detect.

### Review UI

Styled after [schemabuddy.dev](https://www.schemabuddy.dev/): dark by default, with a light/dark toggle in the top-right corner.

- Click a box to select it (Shift-click for several).
- **M** merges, **S** splits (re-clusters at half the gap), **X** excludes, **Del** deletes.
- Drag on an empty part of the page to draw a box by hand, or drag a selected box's corners to resize it.
- Rename an asset in the sidebar. The thumbnails are the actual exported SVGs; **Copy** puts an asset's SVG markup on the clipboard.
- **/** filters the list by name or label text. **⌘/Ctrl + scroll** (or pinch) zooms around the pointer; **+ − 0** zoom in, out and to fit.
- **?** lists every shortcut.
- **Ctrl/⌘ Z** undoes the last edit, **Ctrl/⌘ Shift Z** (or Ctrl Y) redoes it. Undo history lasts until you open another file or leave the page (the local server also drops it on restart).
- **E** opens the export dialog (download a .zip, or save to a folder). **O** opens a file.
- The sidebar's *All pages* tab lists every page's assets.

## Static app (no Node server)

The review UI can run entirely in the browser. Parsing, detection, session edits,
SVG/PNG export and the zip download all happen on the page. Files stay in the
tab; recent files and their sessions are kept in IndexedDB on that browser.
Nothing is uploaded to a backend.

```sh
npm run build:web      # writes dist/
npm run preview:web    # http://127.0.0.1:4173  (correct .mjs and .wasm types)
```

Open that page, drop `test/fixtures/mockup.pdf` (or any PDF-compatible `.ai`),
and use **Download .zip**. **Save to folder** uses the File System Access API
where the browser has it (Chrome, Edge); other browsers keep the zip download.

The same `ui/` page is what `npm run serve` hosts. The build aliases its data
layer to `client/` so the local server path is unchanged.

### Deploy on Vercel

`vercel.json` is already set up. Import the repo as a Vercel project (it can
stay private) with:

| Setting | Value |
| --- | --- |
| Framework preset | Other |
| Root directory | repository root |
| Build command | `npm run build:web` |
| Output directory | `dist` |
| Install command | `npm ci` (default; devDependencies are required for the build) |

No environment variables. The PDF.js worker (`.mjs`) and resvg (`.wasm`) need
to be served as JavaScript and WebAssembly; the headers in `vercel.json` set
that. Any other static host works the same way: publish `dist/` and serve
`.mjs` as `text/javascript` and `.wasm` as `application/wasm`.

PNG export uses `@resvg/resvg-wasm` (same renderer family as the CLI). If that
file fails to load, the page falls back to drawing the SVG on a canvas and says
so in the sidebar. The contact sheet is included in the zip, as in the CLI.

Files over 300MB are refused before they are parsed. A file that is not
PDF-compatible (no `%PDF-` header in the first 1KB) is rejected with the same
"Create PDF Compatible File" message as the local server, and is not added to
Recent.

## Develop

```sh
npm test            # regression tests against test/fixtures/mockup.pdf
npm run fixture     # regenerate the synthetic fixture
```

CI runs `npm test` on Node 20, 22 and 24 for every push (`.github/workflows/test.yml`).

The landing page is a single static file, `docs/index.html` (no build step). To
publish it, turn on GitHub Pages for the `master` branch's `/docs` folder.

See `CLAUDE.md` for the design, known limitations and open questions.
