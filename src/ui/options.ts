import type { ArtOptions } from "../art/generate";

export const WIDTH_RANGE = [1, 1000] as const;
export const DETAIL_RANGE = [2, 32] as const;

/** The option fields as entered. */
export interface OptionFields {
  width: string;
  detail: string;
  invert: boolean;
  contrast: string;
  edges: string;
}

function unit(text: string): number | null {
  const v = Number(text);
  return text.trim() !== "" && v >= 0 && v <= 1 ? v : null;
}

/** Validates the option fields; returns an error message when invalid. */
export function readOptions(f: OptionFields): ArtOptions | string {
  const w = Number(f.width);
  const d = Number(f.detail);
  if (f.width.trim() === "" || !Number.isInteger(w) || w < WIDTH_RANGE[0] || w > WIDTH_RANGE[1]) {
    return `Max width must be a whole number from ${WIDTH_RANGE[0]} to ${WIDTH_RANGE[1]}.`;
  }
  if (f.detail.trim() === "" || !Number.isInteger(d) || d < DETAIL_RANGE[0] || d > DETAIL_RANGE[1]) {
    return `Detail must be a whole number from ${DETAIL_RANGE[0]} to ${DETAIL_RANGE[1]}.`;
  }
  const contrast = unit(f.contrast);
  if (contrast === null) return "Contrast boost must be a number from 0 to 1.";
  const edges = unit(f.edges);
  if (edges === null) return "Edge boost must be a number from 0 to 1.";
  return { widthCells: w, detail: d, preprocess: { invert: f.invert, contrast, edges } };
}
