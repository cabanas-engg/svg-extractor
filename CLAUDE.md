# SVG Extractor — Project Guide

## What this is

A tool that takes an Illustrator (`.ai`) or PDF file full of mockup/brochure
artwork — icons, diagrams, annotated callouts — and pulls out individual assets
as clean, standalone SVGs (and PNGs), without a human manually eyeballing pixel
coordinates for every crop.

This grew out of doing this by hand in Claude chat for AES/Alliance Elevator
configurator mockups (LiftCom package graphics, EdgeSL door/counterweight
diagrams). That worked, but every file needed:

- Working around `.ai` uploads arriving corrupted (binary mangled by the chat
  upload pipeline) by falling back to a PDF export of the same file.
- Manually reading pixel coordinates off a rendered page image to find each
  icon's center.
- Manually tuning a crop radius per batch to avoid bleeding in nearby label text.
- A contact-sheet re-render after every attempt to catch bad crops.

None of that needs a human in the loop. It needs (a) a parser that doesn't choke
on the file, and (b) spatial clustering instead of guessed coordinates.

### Why this shouldn't hit the same corruption problem

The `.ai` corruption was specific to the chat upload pipeline, not to
Illustrator files in general — recent `.ai` files are PDF-compatible under the
hood (Illustrator's "Create PDF Compatible File" option, on for all files tested
so far). This tool reads the file straight off disk and treats `.ai` as PDF end
to end. A file without a `%PDF` header is rejected with an explicit message
(re-save with PDF compatibility on). Never round-trip source files through chat
upload.

## Layout

```
bin/svg-extractor.js   CLI: detect | export | serve | inspect
src/parse.js           PDF.js operator list → flat page elements (paths, images, live text)
src/detect.js          classify roles, outlined-text heuristic, clustering, label pairing, naming
src/session.js         editable session JSON (<file>.extract.json): merge/split/manual/rename/exclude
src/svg.js             element subset → standalone SVG (tight viewBox); SVG → PNG via resvg
src/export.js          batch export, manifest.json, _contact-sheet.png
src/png.js             tiny PNG encoder for embedded raster images
src/server.js          local review UI server (node:http, no framework)
ui/                    review UI (vanilla JS, PDF.js page render + SVG overlay); tokens.css = all design tokens (schemabuddy palette), icons.js = inlined Lucide icons
tools/make-fixture.mjs generates test/fixtures/mockup.{pdf,ai}
tools/eval-reference.mjs scores detection against hand-made reference crops
tools/outline.mjs      outlined-text helper for test sheets (don't use pdfkit's doc.path(svg) — it truncates glyphs)
test/                  node:test regression tests (synthetic fixture + real references when present)
```

Commands: `npm test`, `npm run fixture`, `node bin/svg-extractor.js --help`.

## Core approach (as built)

1. **Parse — `pdfjs-dist`** (pinned 4.10.x; the `constructPath` operator format
   changed in 5.x, so bumping it means updating `src/parse.js`). Pure JS, no
   native binary (unlike poppler/pdftocairo — GPL, painful to bundle).
2. **Extract geometry** — `parse.js` walks the operator list itself, tracking
   the graphics state (CTM, save/restore, form XObjects, colours, line style,
   alpha, clip stack). Each painted path becomes an element with its local-space
   path data, its CTM, an exact viewport-space bbox (Bezier extrema, stroke
   width, clip-intersected) and per-subpath bboxes. Coordinates are PDF points,
   top-left origin. Live text comes from `getTextContent()`.
3. **Classify** — each element is `background` (≥ 20% page area, or the
   artboard frame), `rule` (long thin dividers), `speck`, `text`, or `geometry`.
   Only geometry clusters into assets.
4. **Filter out label text** — outlined glyphs are ordinary paths, so text is
   inferred: runs of ≥ 3 small, similarly sized shapes, horizontally close
   (gap ≤ 0.7 × height) but barely overlapping, mostly on a shared baseline,
   wider than tall overall, one colour, and not all identical (identical = a
   dash/dot pattern). Near-duplicate shapes are folded into one glyph first:
   outlined Illustrator art paints many shapes twice (the shape + a slightly
   larger white knockout "halo" behind it), which otherwise doubles the glyph
   count and turns a pair of arrows into a "word". A second pass catches
   words outlined as one compound path by running the same test on its outer
   subpaths. Small marks inside a text row's band (punctuation) join the row.
   Lines stack into label blocks. Text, specks and rules fully inside an asset
   (lettering on an icon, a tiny detail, a divider inside a card) are kept with
   that asset; only free-standing ones are dropped.
5. **Cluster** — union geometry whose bboxes are within `gap` (default 10pt).
   Assets get reading-order row/col, the nearest label below (preferred) or
   above, and a suggested name: the label's text if it's live text, else
   `p{page}_r{row}_c{col}`.
6. **Export** — SVG writes just the asset's elements, verbatim with their
   transforms (so stroke scaling is exact) and clip paths, into a tight viewBox
   (+ `pad`). PNG rasterises *that same SVG* via `@resvg/resvg-js` (option 2 from
   the original spec — one crop path for both formats). PNG default 3× native
   size, `--scale` to override. Default format SVG; `--format svg,png` for both.
   Every export writes `manifest.json` (names, boxes, sizes, colours used) and
   `_contact-sheet.png`.
7. **Review/correct UI** (`serve`) — the page is rendered by PDF.js in the
   browser (ground truth), boxes overlaid in the same pt space. Click/shift-click
   to select, Merge (M), Split (S: re-cluster at half the gap), Exclude (X),
   Delete, drag on empty page to draw a manual box, drag corners to resize (a
   resized box becomes manual: "whatever is mostly inside it"). Rename inline;
   thumbnails are the real exported SVGs. Tuning popover re-detects the page with
   new thresholds (manual boxes survive). All edits save to the session file,
   which `export` then uses.

All thresholds are in `DEFAULTS` in `src/detect.js` and settable via CLI
(`--gap`, `--pad`, `--max-glyph-height`, `--set key=value`) or the UI.

## Known hard parts (don't pretend these are solved)

- **Text vs. icon separation is a heuristic.** Validated on the synthetic
  fixture and on the 18 hand-made LiftCom crops (see below), but not yet on a
  real, busy mockup page with its real spacing. Known failure modes:
  a tight row of 3+ small, varied shapes reads as text; very large display type
  (> `maxGlyphHeight`) reads as geometry; script/connected lettering may not.
- **Outlined labels can't name assets.** Outlined text has no string, so names
  fall back to `p1_r2_c3`. OCR (e.g. tesseract.js) on the label crop would fix
  this — not built.
- **Dense layouts** (icons touching each other or their labels) produce wrong
  clusters. The UI escape hatches (split, draw, resize) carry real weight.
- **Color/stroke semantics** ("gray glyph, orange ring" vs "fully orange")
  aren't inferred. The manifest lists each asset's fills/strokes so a rule can
  be written against it when needed.
- **Not fully supported** (warned per page, never silent): gradients/patterns
  (approximated as a solid colour), smooth shading fills (skipped), blend modes
  and soft masks (ignored), live text (exported with a fallback font, black
  fill). Image stencil masks are implemented but untested against a real file.
- **Proprietary `.ai` features** not in the PDF-compatible stream (live effects,
  some blend modes) won't round-trip. Fine for outlined/flattened artwork
  (files so far are literally named "...Outlined...").

## Reference set: LiftCom icons

`liftcom_icons_svg.zip` holds the 18 crops made by hand in chat (pdftocairo
output; viewBoxes are in the original page's coordinates, ~1pt margin). It's
client artwork, so it lives in `test/fixtures/real/liftcom_icons_svg/`
(gitignored). `node tools/eval-reference.mjs test/fixtures/real/liftcom_icons_svg`
lays them out on a sheet with outlined labels underneath, runs detection and
checks each comes back as exactly one asset with exactly its paths;
`test/reference.test.js` runs the same check when the folder exists.

Current result: 18/18 intact and labelled, crop sizes matching the hand-made
ones to 0.01pt. Getting there needed the halo folding, single-colour and
overlap rules above, and adopting contained specks. The two large panels
(pricing panel, core card) only survive the background rule because the test
page is as big as the real one (≥ 1219×2283pt, from the crops' coordinates) —
on a smaller page they'd be classed as background (`backgroundArea`, 20% of
the page). A hand-drawn box always recovers them.

## UI direction: schemabuddy.dev

The review UI follows schemabuddy.dev — Nano's visual SQL schema explorer,
source in `cabanas-engg/schema-buddy` (React + Tailwind + shadcn/ui). This app
stays vanilla JS/CSS, so the look is carried over by tokens, not components:

- **Tokens** — `ui/tokens.css` copies schema-buddy's `src/index.css` colour
  variables verbatim (same names, HSL triplets, used as `hsl(var(--x))`), light
  in `:root` and dark in `.dark`. To resync, copy the blocks across.
  Extractor-only tokens map onto that palette: auto boxes = `--primary`
  (emerald), hand-drawn = `--accent` (purple), selection = `--table-pk` (amber),
  labels = `--table-column` (blue), label links = `--relationship-line`.
- **Type** — Space Grotesk (UI) and JetBrains Mono (names, numbers, file
  paths), from Google Fonts like schema-buddy; system fallbacks offline.
- **Theme** — dark by default (`<html class="dark">`), sun/moon toggle,
  choice kept in `localStorage['svgx-theme']`.
- **Layout** — schema-buddy's app view: left sidebar (brand tile + title +
  10px subtitle, collapse button; tabs; asset list; primary action with
  `glow-primary` + outline secondary buttons in a 2-column grid), slim top bar,
  toolbar with mono stat counters on the left and a bordered segmented control
  group on the right (zoom − % + · fit · Tuning), canvas as a bordered,
  rounded panel on `--background / 0.5` with a dot grid. Popovers, the export
  dialog and toasts use the card/popover tokens.
- **Icons** — Lucide (same set as schema-buddy), inlined in `ui/icons.js`
  (generated from `lucide-react` 0.462.0; ISC). Use `<i data-icon="name">` in
  HTML or `icon(name)` in JS.

Nothing in `app.css` hard-codes a colour; everything goes through tokens.

## Decisions taken (provisional — confirm with Nano)

- **Delivery shape:** CLI core + thin local web UI on top (`serve`), sharing
  one session file. Batch runs can skip the UI entirely.
- **Where it lives:** `cabanas-engg/svg-extractor`. Fronda Digital vs.
  standalone vs. personal is still open.
- **Naming:** the tool suggests names (nearest label's text, else grid
  position) and the user accepts/edits in the UI.

## Status

- Built: parser, classifier/text heuristic, clustering, label pairing, session
  model with merge/split/manual/resize/rename/exclude, SVG+PNG export,
  manifest, contact sheet, review UI, CLI, regression tests (fixture only).
- Validated against the 18 LiftCom reference crops (18/18).
- Review UI restyled to match schemabuddy.dev (dark default + light toggle).
- Next: run against a real AES mockup source file (`.ai`/PDF, into
  `test/fixtures/real/`) to check real spacing and labels; OCR naming for
  outlined labels.
