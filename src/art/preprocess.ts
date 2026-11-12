// Preprocessing options of a conversion and how they map to the backend.
//
// The three steps are independent: each can be used alone or with any of
// the others, and they are applied to the grey image in the order flip,
// contrast boost, edge boost.

import type { Preprocessing } from "../engine/backend";
import type { Geometry } from "./geometry";

export interface PreprocessOptions {
  /** Flip black and white. */
  invert: boolean;
  /** Contrast boost in [0, 1]: 0 is off, 1 thresholds at the mean grey. */
  contrast: number;
  /** Edge boost strength in [0, 1]: 0 is off. */
  edges: number;
}

export const DEFAULT_PREPROCESS: Readonly<PreprocessOptions> = { invert: false, contrast: 0.5, edges: 0.5 };

/** Unsharp mask amount at full edge boost strength. */
export const MAX_EDGE_AMOUNT = 8;
/**
 * Blur radius (sigma) of the edge boost in cells, so it looks the same at
 * any image size. Narrower halos average out within a character.
 */
export const EDGE_SIGMA_CELLS = 1;

export function toPreprocessing(p: PreprocessOptions, imageWidth: number, geometry: Geometry): Preprocessing {
  const sourcePxPerSample = imageWidth / geometry.widthPx;
  return {
    invert: p.invert,
    contrast: p.contrast,
    edgeAmount: p.edges * MAX_EDGE_AMOUNT,
    // At least a source pixel, which matters when the image is enlarged.
    edgeSigma: Math.max(1, EDGE_SIGMA_CELLS * geometry.detail * sourcePxPerSample),
  };
}
