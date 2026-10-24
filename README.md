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

```sh
# one shot: detect + export SVGs (+ manifest.json, _contact-sheet.png)
node bin/svg-extractor.js export sheet.ai -o icons/

# SVG and PNG at 4x
node bin/svg-extractor.js export sheet.ai -o icons/ --format svg,png --scale 4

# review and correct in the browser, then export from there or the CLI
node bin/svg-extractor.js serve sheet.ai        # http://127.0.0.1:5178

# just detect (writes sheet.ai.extract.json) / see what the parser found
node bin/svg-extractor.js detect sheet.ai
node bin/svg-extractor.js inspect sheet.ai
```

Corrections made in the UI are saved to `<file>.extract.json`, and `export`
picks that session up automatically. Pass `--redetect` to start over.

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

- Click a box to select it (Shift-click for several).
- **M** merges, **S** splits (re-clusters at half the gap), **X** excludes, **Del** deletes.
- Drag on an empty part of the page to draw a box by hand, or drag a selected box's corners to resize it.
- Rename an asset in the sidebar. The thumbnails are the actual exported SVGs.

## Develop

```sh
npm test            # regression tests against test/fixtures/mockup.pdf
npm run fixture     # regenerate the synthetic fixture
```

See `CLAUDE.md` for the design, known limitations and open questions.
