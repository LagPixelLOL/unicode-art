// Checks that the browser's native text rendering reproduces the computed
// result: same glyphs, same fonts, same positions.

import type { ComputeBackend } from "../engine/backend";
import { cssFont, nextTask, textContext } from "./atlas";
import type { ArtResult } from "./generate";

export const CANVAS_MIN_SIMILARITY = 0.97;
export const CANVAS_MIN_ROW_SIMILARITY = 0.9;
/**
 * A run of text and individually placed glyphs can differ by a fraction of a
 * pixel in placement, which flips fine textures such as shade characters.
 * Comparing after a small blur makes the check about which glyphs were
 * drawn where, not about sub-pixel phase.
 */
export const BLUR_RADIUS = 1;

export interface CanvasCheck {
  pass: boolean;
  similarity: number;
  worstRow: number;
  worstRowSimilarity: number;
  badRows: number;
  /**
   * Largest difference between the width of a row as one native run and the
   * sum of its glyphs measured one by one (sampling pixels). Non-zero when
   * the browser changes advances in context, e.g. by clustering characters.
   */
  maxAdvanceError: number;
  advanceRows: number;
}

/** Allowed run vs glyph sum difference in sampling pixels. */
export function advanceTolerance(rowPx: number): number {
  return Math.max(0.5, rowPx * 0.001);
}

/**
 * Canvas has no switch for ligatures, but any non-zero letter spacing turns
 * optional ligatures off (as `font-variant-ligatures: none` does in the
 * output). The computed rendering adds the same spacing per glyph.
 */
export const LIGATURE_BREAKING_SPACING = 0.001;

function context(w: number, h: number): OffscreenCanvasRenderingContext2D {
  const ctx = textContext(w, h);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#fff";
  return ctx;
}

/**
 * Renders every row as one native text run with the full font stack, and
 * separately draws the row as runs of the glyphs matched with each font,
 * using only that font, then compares both pixel by pixel. Within a run
 * both drawings use the same native text path, so they agree to the sub
 * pixel; a glyph that the full stack draws with another font (or shapes
 * differently) changes its pixels and shifts everything after it. Exact
 * positions are checked by the page layout check.
 */
export interface FontSegment {
  font: number;
  text: string;
}

/** Splits a row into runs of consecutive glyphs matched with the same font. */
export function fontSegments(result: Pick<ArtResult, "layout" | "glyphFont" | "glyphCodepoint">, row: number): FontSegment[] {
  const { layout } = result;
  const out: FontSegment[] = [];
  for (let i = layout.rowOffsets[row]; i < layout.rowOffsets[row + 1]; i++) {
    const g = layout.glyphs[i];
    const font = result.glyphFont[g];
    const ch = String.fromCodePoint(result.glyphCodepoint[g]);
    const last = out.at(-1);
    if (last && last.font === font) last.text += ch;
    else out.push({ font, text: ch });
  }
  return out;
}

/** Rows drawn or compared between checks for cancellation. */
const VERIFY_SLICE = 32;

export async function verifyCanvas(result: ArtResult, backend: ComputeBackend, signal?: AbortSignal): Promise<CanvasCheck> {
  const { geometry: geo, rows } = result;
  const w = geo.widthPx;
  const h = rows * geo.cellH;
  const native = context(w, h);
  native.font = cssFont(geo.fontPx, result.families);
  native.letterSpacing = `${LIGATURE_BREAKING_SPACING}px`;
  const computed = context(w, h);
  computed.letterSpacing = `${LIGATURE_BREAKING_SPACING}px`;
  const glyphWidth = new Map<number, number>();
  let maxAdvanceError = 0;
  let advanceRows = 0;
  for (let r = 0; r < rows; r++) {
    if (r % VERIFY_SLICE === VERIFY_SLICE - 1) {
      await nextTask();
      signal?.throwIfAborted();
    }
    const y = r * geo.cellH + geo.baselinePx;
    native.fillText(result.lines[r], 0, y);
    let x = 0;
    for (const seg of fontSegments(result, r)) {
      computed.font = cssFont(geo.fontPx, result.families[seg.font]);
      computed.fillText(seg.text, x, y);
      x += computed.measureText(seg.text).width;
    }
    // Glyphs measured on their own, each with its matched font.
    let sum = 0;
    for (let i = result.layout.rowOffsets[r]; i < result.layout.rowOffsets[r + 1]; i++) {
      const g = result.layout.glyphs[i];
      let gw = glyphWidth.get(g);
      if (gw === undefined) {
        computed.font = cssFont(geo.fontPx, result.families[result.glyphFont[g]]);
        gw = computed.measureText(String.fromCodePoint(result.glyphCodepoint[g])).width;
        glyphWidth.set(g, gw);
      }
      sum += gw;
    }
    const err = Math.abs(native.measureText(result.lines[r]).width - sum);
    maxAdvanceError = Math.max(maxAdvanceError, err);
    if (err > advanceTolerance(sum)) advanceRows++;
  }
  const a = native.getImageData(0, 0, w, h).data;
  const b = computed.getImageData(0, 0, w, h).data;
  const all = await backend.compareImages(a, b, w, 0.25, BLUR_RADIUS);
  let worstRow = -1;
  let worstRowSimilarity = 1;
  let badRows = 0;
  const band = geo.cellH * w * 4;
  for (let r = 0; r < rows; r++) {
    if (r % VERIFY_SLICE === VERIFY_SLICE - 1) {
      await nextTask();
      signal?.throwIfAborted();
    }
    const c = await backend.compareImages(
      a.subarray(r * band, (r + 1) * band),
      b.subarray(r * band, (r + 1) * band),
      w,
      0.25,
      BLUR_RADIUS,
    );
    if (c.similarity < CANVAS_MIN_ROW_SIMILARITY) badRows++;
    if (c.similarity < worstRowSimilarity) {
      worstRowSimilarity = c.similarity;
      worstRow = r;
    }
  }
  return {
    pass: all.similarity >= CANVAS_MIN_SIMILARITY && badRows === 0 && advanceRows === 0,
    similarity: all.similarity,
    worstRow,
    worstRowSimilarity,
    badRows,
    maxAdvanceError,
    advanceRows,
  };
}

export interface DomMeasurements {
  /** Rendered font size in CSS pixels. */
  fontSize: number;
  /** Text content of every rendered line. */
  texts: string[];
  /** Rendered width of every line in CSS pixels. */
  widths: number[];
  /** Pen offset of sampled glyphs: [row, glyph index, offset px]. */
  samples: [number, number, number][];
  /** Baseline offset from the top of the first line in CSS pixels. */
  baseline: number | null;
}

export interface DomCheck {
  pass: boolean;
  textMatches: boolean;
  maxWidthError: number;
  maxPositionError: number;
  baselineError: number;
  checkedGlyphs: number;
  worstRow: number;
}

export function domTolerance(px: number): number {
  return Math.max(0.5, px * 0.001);
}

/** Browsers round font ascent, descent and half leading to whole layout pixels. */
export function baselineTolerance(fontSize: number): number {
  return Math.max(1, fontSize * 0.03);
}

/** Compares DOM measurements (see OutputView.measure) with the layout. */
export function evaluateDom(result: ArtResult, m: DomMeasurements): DomCheck {
  const scale = m.fontSize / result.geometry.fontPx;
  let textMatches = m.texts.length === result.lines.length;
  let maxWidthError = 0;
  let worstRow = -1;
  let pass = true;
  for (let r = 0; r < result.lines.length; r++) {
    if (m.texts[r] !== result.lines[r]) textMatches = false;
    const expected = result.layout.rowWidths[r] * scale;
    const err = Math.abs((m.widths[r] ?? 0) - expected);
    if (err > maxWidthError) {
      maxWidthError = err;
      worstRow = r;
    }
    if (err > domTolerance(expected)) pass = false;
  }
  let maxPositionError = 0;
  for (const [r, i, offset] of m.samples) {
    const expected = result.layout.positions[i] * scale;
    const err = Math.abs(offset - expected);
    maxPositionError = Math.max(maxPositionError, err);
    if (err > domTolerance(expected)) {
      pass = false;
      if (worstRow < 0) worstRow = r;
    }
  }
  const baselineError = m.baseline === null ? 0 : Math.abs(m.baseline - result.geometry.baselinePx * scale);
  if (baselineError > baselineTolerance(m.fontSize)) pass = false;
  return {
    pass: pass && textMatches,
    textMatches,
    maxWidthError,
    maxPositionError,
    baselineError,
    checkedGlyphs: m.samples.length,
    worstRow,
  };
}
