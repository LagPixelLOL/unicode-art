# Unicode Art

A web app that turns an image into text art made of the characters of your
fonts. The result is plain Unicode text, rendered natively by the browser and
ready to copy.

- Upload an image, paste one anywhere on the page (Ctrl+V), or drop one
  anywhere. A new image always replaces the current one. Transparent areas are
  padded with white and colors are converted to grey, since the output is
  monochrome.
- Fonts come from presets (downloaded at run time, only when a conversion
  needs them; the default preset is the entire Noto family from Google Fonts,
  and there is a gg sans preset fetched from GitHub), from uploaded files
  (TTF, OTF, TTC, WOFF, WOFF2), or from a URL of a font file or of a
  stylesheet such as `https://fonts.googleapis.com/css2?family=Inter`.
  GitHub file links (`github.com/.../raw/...` or `/blob/...`) are rewritten
  to `raw.githubusercontent.com`, which allows cross-origin downloads.
- Choosing a preset in the dropdown replaces the font list right away. Once
  the list is edited the dropdown shows "Custom", and it shows the preset
  again whenever the list matches one exactly.
- The font list is a priority list: drag entries (or use the arrow buttons)
  to reorder them. A character missing from a font is looked up in the fonts
  below it. Characters that no font has are never used. The total size of the
  loaded fonts is shown under the list (fonts of a preset count once they are
  downloaded). Any change to the list clears the current output, since it was
  rendered with the previous fonts.
- Proportional (variable width) and variable (OpenType variations) fonts are
  fully supported: every glyph is placed at its exact advance.
- Options: maximum width in cells, sampling detail, and flipping black and
  white.
- Nothing runs until you press Start. While converting, Start becomes Cancel,
  which stops the work immediately.
- The output is scaled to fit its box exactly (letterboxed with black where
  the aspect ratio differs). Copy text copies it to the clipboard, and Copy
  escaped copies it with every ASCII punctuation character backslash escaped,
  so it shows literally when pasted into Markdown. Hover the time to see where
  it was spent.
- Every result is verified against the browser's native text rendering (see
  below).

The page is dark mode only and uses Tailwind CSS with the zinc palette.

## Requirements

The app needs both WebGPU and WebAssembly, for example a current Chrome or
Edge. There is no fallback: when either is missing the page explains what is
missing and stops. The code is organised so that another backend can be added
later (see "Backends").

## How it works

1. Characters: the Rust core (WebAssembly) parses each font (WOFF and WOFF2
   are decoded, collections use their first face), reads the cmap, drops
   excluded characters (see below) and merges the fonts by priority. The
   browser then measures every character with its font; characters whose
   browser advance disagrees with the font's own metrics are dropped, as that
   means the browser would not draw them with the expected font.
2. Geometry: a cell is the width of the digit 0 in the font stack (the CSS
   `ch` unit; half an em if no font has a 0). The image is sampled at
   `detail` pixels per cell, so a line is `width * detail` samples wide, and a
   line is as tall as the primary font's ascent plus descent. The number of
   lines follows the image aspect ratio; the height is unbounded.
3. Glyphs: every candidate is drawn natively by the browser, each with its own
   font, and packed by the Rust core into width bins (identical glyphs are
   dropped).
4. Image: the Rust core composites the image over white, converts it to
   luminance, resamples it in linear light and produces the ink target
   (brightness, or darkness when flipped).
5. Matching (WebGPU): a compute shader scores every glyph at every start
   column of every line (squared error) and keeps the best glyph per width
   bin. Work is submitted in small, adaptively sized steps so cancelling is
   immediate and GPU watchdogs are never triggered.
6. Layout (WebAssembly): a dynamic program picks, for each line, the glyph
   sequence with the least total error whose summed advance never exceeds the
   line width. Pen positions keep their exact fractional value, so rounding
   never accumulates along a line.
7. Rendering: the lines are rendered as text with a CSS font stack of the
   loaded fonts, with kerning, ligatures and contextual alternates disabled,
   and scaled to fit the box. Browsers place glyphs with a fixed precision
   (about 1/64 px), an error that adds up along a line at small font sizes,
   so the text is laid out at 128 px or more (a multiple of 1/64 px) and
   scaled down with a CSS transform.

By default bright areas get dense characters, because the output is light
text on black; "Flip black and white" inverts that.

### Verification

Each result is checked twice, and the outcome is shown in the status panel:

- Native text render vs computed glyphs: every line is drawn as one native
  text run with the full font stack, and separately as runs of the glyphs
  matched with each font, drawn with only that font. The two images are
  compared (after a 1 pixel blur). In addition, the width of every line as
  one run is compared with the sum of its glyphs measured one by one. This
  catches wrong font fallback, shaping, and advances that change in context
  (for example characters that the browser clusters with their neighbour).
- Page layout vs computed positions: the rendered page is measured (line
  widths, sampled glyph positions, baseline and text content) and compared
  with the computed layout at the displayed font size.

## Excluded characters

Only characters that render as one standalone, left-to-right advance in
monochrome are used. A character is excluded when any of these rules applies.

Unicode general categories: `Cc` control characters, `Cf` format characters
(zero width characters, bidi controls, joiners), `Cs` surrogates, `Cn`
unassigned code points and noncharacters, `Mn` nonspacing combining marks,
`Mc` spacing combining marks, `Me` enclosing marks, `Zl` line separator,
`Zp` paragraph separator.

Bidi classes: `R` right-to-left letters, `AL` Arabic letters, `AN` Arabic
digits, `NSM` nonspacing marks, `B` paragraph separators, `S` segment
separators such as tab, `BN` boundary neutrals, `LRE`, `LRO`, `RLE`, `RLO`,
`PDF` embedding and override controls, `LRI`, `RLI`, `FSI`, `PDI` isolate
controls.

Grapheme clusters (`Grapheme_Cluster_Break`): characters that join the
character before or after them into one grapheme cluster, such as Extend,
SpacingMark, Prepend and ZWJ characters and Hangul jamo. Browsers lay out,
measure and select a cluster as one unit, so these characters would not get
their own advance. An example is U+FF9E, the halfwidth katakana voiced sound
mark, which is a modifier letter but extends the previous character. The
test is done with the Unicode segmentation rules against usable neighbours
(a Latin letter, Hangul syllables, and the character itself).

Blocks whose characters need complex shaping, joining or form sequences:

| Range | Contents |
| --- | --- |
| `U+0590-U+08FF` | Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic, Arabic extensions |
| `U+0900-U+0DFF` | Indic scripts, Devanagari to Sinhala |
| `U+0F00-U+0FFF` | Tibetan |
| `U+1000-U+109F` | Myanmar |
| `U+1100-U+11FF` | Hangul Jamo (conjoining) |
| `U+1700-U+18AF` | Philippine scripts, Khmer, Mongolian |
| `U+1900-U+1AFF` | Limbu to Tai Tham, combining diacritics extended |
| `U+1B00-U+1C4F` | Balinese, Sundanese, Batak, Lepcha |
| `U+1CD0-U+1CFF` | Vedic extensions |
| `U+3164` | Hangul filler (default ignorable) |
| `U+A800-U+A8FF` | Syloti Nagri, Phags-pa, Saurashtra, Devanagari extended |
| `U+A900-U+A9FF` | Kayah Li, Rejang, Hangul Jamo extended A, Javanese |
| `U+AA00-U+AAFF` | Cham, Myanmar extended, Tai Viet, Meetei Mayek extensions |
| `U+ABC0-U+ABFF` | Meetei Mayek |
| `U+D7B0-U+D7FF` | Hangul Jamo extended B |
| `U+FB1D-U+FDFF` | Hebrew and Arabic presentation forms |
| `U+FE00-U+FE0F` | Variation selectors |
| `U+FE70-U+FEFF` | Arabic presentation forms B, byte order mark |
| `U+FFA0` | Halfwidth Hangul filler |
| `U+10800-U+10FFF` | Historic right-to-left scripts |
| `U+11000-U+11FFF` | Brahmi and other historic Indic scripts |
| `U+1E800-U+1EFFF` | Mende Kikakui, Adlam, Arabic math and other right-to-left scripts |
| `U+1F1E6-U+1F1FF` | Regional indicators (form flags in pairs) |
| `U+1F3FB-U+1F3FF` | Emoji skin tone modifiers |
| `U+E0000-U+E0FFF` | Tags and variation selectors supplement |

Per font, at run time: code points no loaded font maps to a real glyph (glyph
0 is never used), color glyphs (COLR, CBDT, sbix and SVG tables), glyphs with
zero advance, characters whose browser advance disagrees with the font, and
glyphs narrower than one sample or wider than 3 cells.

The rules live in `wasm/src/charset.rs`; the info icon next to "Fonts" shows
the same summary on the page. Tests check that every rule is listed here.

## Project structure

```
index.html              page shell
src/                    web app (TypeScript, React, Tailwind)
  main.tsx              backend selection and mounting
  engine/               compute backend contract and implementations
    backend.ts          ComputeBackend interface
    registry.ts         backend selection (no fallback)
    webgpu-wasm/        WebGPU + WebAssembly backend, WGSL matcher
  art/                  conversion pipeline, geometry, rasterizing, verification
  fonts/                presets, downloads, unicode-range, font list store
  image/                image decoding and file classification
  ui/                   React components and hooks
wasm/                   Rust crate compiled to WebAssembly
  src/                  font parsing, character rules, image preparation,
                        glyph packing, layout solver, image comparison
  tests/                native Rust tests
tests/
  unit/                 Vitest tests (Node, no browser)
  fixtures/fonts/       small test fonts and their license
scripts/make-fixtures.py  regenerates the test fonts
```

Tests are kept outside of the source trees (`src/` and `wasm/src/`).

## Development

Prerequisites: Node.js, the stable Rust toolchain with the
`wasm32-unknown-unknown` target, and `wasm-pack`.

```
npm install
npm run dev        # builds the WebAssembly core, starts Vite on port 12345
npm run build      # production build in dist/
npm test           # builds the core, runs the Rust and the Vitest suites
```

`npm run test:rust` and `npm run test:web` run the suites separately
(`test:web` needs a built core, `npm run build:wasm`).

## Testing

No browser is needed to run the tests.

- Rust (`wasm/tests/`): character rules, font parsing for every container
  format, collections, color, variable, Arabic and shaping heavy fonts, image
  preparation, glyph packing, the layout solver against an exhaustive search,
  image comparison, and WGSL validation of the matcher with naga.
- Vitest (`tests/unit/`): the compiled WebAssembly core through its bindings,
  the WGSL matcher on a native WebGPU implementation (Dawn, from the `webgpu`
  package) against a CPU oracle, the full conversion pipeline with a fake
  canvas, verification (including detecting wrong font fallback), font
  loading, presets, the font list, UI logic and React components (happy-dom),
  and a check that every user facing file is plain ASCII.

The GPU tests are skipped with a warning on machines without any WebGPU
adapter (a software Vulkan driver such as lavapipe is enough).

## Backends

All performance sensitive work goes through the `ComputeBackend` interface
in `src/engine/backend.ts`. To add a backend, implement the interface (and a
`BackendFactory` that probes for what it needs) and register the factory in
`src/engine/registry.ts`. The current WebGPU + WebAssembly backend lives in
`src/engine/webgpu-wasm/`.

## Test fonts

The fonts in `tests/fixtures/fonts/` are renamed subsets of the Liberation
fonts, Noto Color Emoji, Noto Sans and Noto Sans Arabic, all under the SIL
Open Font License 1.1 (see `tests/fixtures/fonts/OFL.txt`).
