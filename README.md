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
node bin/svg-extractor.js serve                 # then open http://127.0.0.1:5178
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
- Rename an asset in the sidebar. The thumbnails are the actual exported SVGs.
- **Ctrl/⌘ Z** undoes the last edit, **Ctrl/⌘ Shift Z** (or Ctrl Y) redoes it. Undo history lasts until you open another file or restart the server.
- **E** opens the export dialog (download a .zip, or save to a folder). **O** opens a file.
- The sidebar's *All pages* tab lists every page's assets.

## Develop

```sh
npm test            # regression tests against test/fixtures/mockup.pdf
npm run fixture     # regenerate the synthetic fixture
```

CI runs `npm test` on Node 20 and 22 for every push (`.github/workflows/test.yml`).

See `CLAUDE.md` for the design, known limitations and open questions.
