// Preprocessing options of a conversion and how they map to the backend.
//
// The three steps are independent: each can be used alone or with any of
// the others, and they are applied to the grey image in the order flip,
// contrast boost, edge boost.

import type { Preprocessing } from "../engine/backend";

export interface PreprocessOptions {
  /** Flip black and white. */
  invert: boolean;
  /** Contrast boost in [0, 1]: 0 is off, 1 is the strongest. */
  contrast: number;
  /** Edge boost strength in [0, 1]: 0 is off. */
  edges: number;
}

export const DEFAULT_PREPROCESS: Readonly<PreprocessOptions> = { invert: false, contrast: 0.5, edges: 0.5 };

/**
 * Contrast boost is guided by local contrast, so dark or bright regions keep
 * their detail: it equalizes tile by tile (CLAHE) with a clip limit from 1
 * (no change) up to this at full strength, then spreads every pixel away
 * from its local mean with an S-curve.
 */
export const MAX_CLIP_LIMIT = 16;
/** S-curve strength at full contrast boost; 1 would threshold. */
export const MAX_CURVE = 0.75;
/** Equalized tiles are about this many cells wide, at any image size. */
export const CONTRAST_TILE_CELLS = 10;
/** Radius (sigma) of the local mean the S-curve pivots on, in cells. */
export const CURVE_SIGMA_CELLS = 4;

/**
 * Scale (sigma) of the outlines edge boost draws, in cells, so they look the
 * same at any image size: thin enough to follow details, wide enough to
 * survive at character resolution.
 */
export const EDGE_SIGMA_CELLS = 0.25;

/** Backend parameters for an image `imageWidth` pixels wide converted to `widthCells` cells. */
export function toPreprocessing(p: PreprocessOptions, imageWidth: number, widthCells: number): Preprocessing {
  return {
    invert: p.invert,
    clipLimit: 1 + p.contrast * (MAX_CLIP_LIMIT - 1),
    tileSize: (CONTRAST_TILE_CELLS * imageWidth) / widthCells,
    curve: p.contrast * MAX_CURVE,
    curveSigma: Math.max(1, (CURVE_SIGMA_CELLS * imageWidth) / widthCells),
    edges: p.edges,
    // At least a source pixel, which matters when the image is enlarged.
    edgeSigma: Math.max(1, (EDGE_SIGMA_CELLS * imageWidth) / widthCells),
  };
}
