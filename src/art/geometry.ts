// Pure geometry of the computation grid.
//
// A "cell" is the advance of the digit zero in the font stack (the CSS `ch`
// unit). The image is sampled at `detail` pixels per cell, so the row width
// in pixels is `widthCells * detail` and the font is rasterized at the size
// that makes one cell exactly `detail` pixels wide.

export interface GeometryInput {
  /** Advance of "0" in em (0.5 when no font has "0"). */
  chEm: number;
  /** Ascent and descent of the primary font in em (both positive). */
  ascentEm: number;
  descentEm: number;
  /** Sampling pixels per cell. */
  detail: number;
  /** Maximum output width in cells. */
  widthCells: number;
}

export interface Geometry {
  /** Font size in sampling pixels. */
  fontPx: number;
  /** Row width in sampling pixels. */
  widthPx: number;
  /** Row height in sampling pixels. */
  cellH: number;
  /** Row height in em, used for the native rendering. */
  lineHeightEm: number;
  /** Baseline offset from the top of a row in sampling pixels. */
  baselinePx: number;
  detail: number;
  widthCells: number;
}

export const MAX_GLYPH_CELLS = 3;
export const DEFAULT_CH_EM = 0.5;

export function computeGeometry(g: GeometryInput): Geometry {
  if (!(g.chEm > 0) || !(g.detail >= 1) || !(g.widthCells >= 1)) throw new Error("Invalid geometry input");
  const fontPx = g.detail / g.chEm;
  const contentPx = (g.ascentEm + g.descentEm) * fontPx;
  const cellH = Math.max(1, Math.round(contentPx));
  return {
    fontPx,
    widthPx: Math.round(g.widthCells) * Math.round(g.detail),
    cellH,
    lineHeightEm: cellH / fontPx,
    // CSS centers the font's content area inside the line box (half leading).
    baselinePx: (cellH - contentPx) / 2 + g.ascentEm * fontPx,
    detail: Math.round(g.detail),
    widthCells: Math.round(g.widthCells),
  };
}

/** Number of text rows that keeps the image aspect ratio. */
export function rowCount(imageW: number, imageH: number, geo: Geometry): number {
  return Math.max(1, Math.round((geo.widthPx * imageH) / imageW / geo.cellH));
}

export interface GlyphSelection {
  /** Charset index of every glyph id. */
  charsetIndex: Uint32Array;
  /** Exact advance in sampling pixels per glyph id. */
  advancePx: Float32Array;
  /** Matching width (rounded advance) per glyph id. */
  widths: Uint32Array;
  /** Charset entries dropped for being narrower than a pixel or too wide. */
  tooNarrow: number;
  tooWide: number;
}

/**
 * Keeps glyphs with an advance of at least one sampling pixel (so the pen
 * always moves) and at most MAX_GLYPH_CELLS cells.
 */
export function selectGlyphs(advanceEm: ArrayLike<number>, geo: Geometry, usable?: ArrayLike<boolean>): GlyphSelection {
  const maxPx = MAX_GLYPH_CELLS * geo.detail;
  const idx: number[] = [];
  const adv: number[] = [];
  const wid: number[] = [];
  let tooNarrow = 0;
  let tooWide = 0;
  for (let i = 0; i < advanceEm.length; i++) {
    if (usable && !usable[i]) continue;
    const px = advanceEm[i] * geo.fontPx;
    if (!(px >= 1)) {
      tooNarrow++;
      continue;
    }
    if (px > maxPx) {
      tooWide++;
      continue;
    }
    idx.push(i);
    adv.push(px);
    wid.push(Math.max(1, Math.round(px)));
  }
  return {
    charsetIndex: Uint32Array.from(idx),
    advancePx: Float32Array.from(adv),
    widths: Uint32Array.from(wid),
    tooNarrow,
    tooWide,
  };
}
