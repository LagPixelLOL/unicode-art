import type { ArtOptions } from "../art/generate";

export const WIDTH_RANGE = [1, 1000] as const;
export const DETAIL_RANGE = [2, 32] as const;

/** Validates the option fields; returns an error message when invalid. */
export function readOptions(width: string, detail: string, invert: boolean): ArtOptions | string {
  const w = Number(width);
  const d = Number(detail);
  if (width.trim() === "" || !Number.isInteger(w) || w < WIDTH_RANGE[0] || w > WIDTH_RANGE[1]) {
    return `Max width must be a whole number from ${WIDTH_RANGE[0]} to ${WIDTH_RANGE[1]}.`;
  }
  if (detail.trim() === "" || !Number.isInteger(d) || d < DETAIL_RANGE[0] || d > DETAIL_RANGE[1]) {
    return `Detail must be a whole number from ${DETAIL_RANGE[0]} to ${DETAIL_RANGE[1]}.`;
  }
  return { widthCells: w, detail: d, invert };
}
