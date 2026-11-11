// Builds the candidate character set from the loaded fonts.

import type { ComputeBackend, FontInfoData } from "../engine/backend";
import { cssFont, textContext } from "./atlas";
import { DEFAULT_CH_EM } from "./geometry";

export interface FontRef {
  id: number;
  family: string;
  info: FontInfoData;
}

export interface CharsetData {
  key: string;
  /** CSS family names in priority order. */
  families: string[];
  codepoints: Uint32Array;
  /** Font (index into `families`) that renders each code point. */
  fontIndex: Uint32Array;
  /** Advance in em as measured by the browser. */
  advanceEm: Float64Array;
  chEm: number;
  ascentEm: number;
  descentEm: number;
  /** Characters dropped because the browser advance disagrees with the font. */
  mismatched: number;
  /** Characters contributed by each font. */
  perFont: number[];
}

export function charsetKey(fonts: readonly FontRef[]): string {
  return fonts.map((f) => f.id).join(",");
}

/** Binary search of a code point in a font's sorted coverage. */
export function fontAdvance(info: FontInfoData, cp: number): number | null {
  let lo = 0;
  let hi = info.codepoints.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = info.codepoints[mid];
    if (v === cp) return info.advances[mid] / info.unitsPerEm;
    if (v < cp) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

/**
 * The browser is the source of truth for advances (it applies variation
 * axes), but for static fonts a disagreement with the font's own metrics
 * means the browser is not rendering this character with the expected font.
 */
export function advanceAgrees(browserEm: number, fontEm: number, isVariable: boolean): boolean {
  if (!(browserEm > 0)) return false;
  if (isVariable) return true;
  return Math.abs(browserEm - fontEm) <= Math.max(0.002, fontEm * 0.01);
}

const MEASURE_PX = 1000;

export async function buildCharset(backend: ComputeBackend, fonts: readonly FontRef[]): Promise<CharsetData> {
  const merged = await backend.mergeCoverage(fonts.map((f) => f.info.codepoints));
  const ctx = textContext(1, 1);

  const n = merged.codepoints.length;
  const cps: number[] = [];
  const fis: number[] = [];
  const advs: number[] = [];
  const perFont = fonts.map(() => 0);
  let mismatched = 0;
  let font = -1;
  for (let i = 0; i < n; i++) {
    const cp = merged.codepoints[i];
    const fi = merged.fontIndex[i];
    if (fi !== font) {
      ctx.font = cssFont(MEASURE_PX, fonts[fi].family);
      font = fi;
    }
    const em = ctx.measureText(String.fromCodePoint(cp)).width / MEASURE_PX;
    const info = fonts[fi].info;
    const fontEm = fontAdvance(info, cp) ?? 0;
    if (!advanceAgrees(em, fontEm, info.isVariable)) {
      mismatched++;
      continue;
    }
    cps.push(cp);
    fis.push(fi);
    advs.push(em);
    perFont[fi]++;
  }

  const zero = cps.indexOf(0x30);
  const chEm = zero >= 0 ? advs[zero] : DEFAULT_CH_EM;

  // Line metrics come from the primary (first) font, like CSS does.
  const primary = fonts[0];
  ctx.font = cssFont(MEASURE_PX, primary.family);
  const m = ctx.measureText("0");
  const upem = primary.info.unitsPerEm;
  const ascentEm = Number.isFinite(m.fontBoundingBoxAscent)
    ? m.fontBoundingBoxAscent / MEASURE_PX
    : primary.info.ascender / upem;
  const descentEm = Number.isFinite(m.fontBoundingBoxDescent)
    ? m.fontBoundingBoxDescent / MEASURE_PX
    : -primary.info.descender / upem;

  return {
    key: charsetKey(fonts),
    families: fonts.map((f) => f.family),
    codepoints: Uint32Array.from(cps),
    fontIndex: Uint32Array.from(fis),
    advanceEm: Float64Array.from(advs),
    chEm,
    ascentEm,
    descentEm,
    mismatched,
    perFont,
  };
}
