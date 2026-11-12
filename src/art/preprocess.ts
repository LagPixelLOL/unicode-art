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

/**
 * Upper bounds of the radii as shares of the image's longer side. With few
 * cells a cell spans much of the image, and radii in cells would blur it
 * into blobs: outlines stay lines, the local mean stays local, and there
 * are always a few tiles to equalize.
 */
export const MAX_EDGE_SIGMA_SHARE = 1 / 300;
export const MAX_CURVE_SIGMA_SHARE = 1 / 12;
export const MAX_TILE_SHARE = 1 / 4;

/** Backend parameters for an image converted to `widthCells` cells. */
export function toPreprocessing(p: PreprocessOptions, image: { width: number; height: number }, widthCells: number): Preprocessing {
  const cell = image.width / widthCells;
  const long = Math.max(image.width, image.height);
  // Radii are at least a source pixel, which matters when the image is enlarged.
  const radius = (cells: number, share: number) => Math.max(1, Math.min(cells * cell, share * long));
  return {
    invert: p.invert,
    clipLimit: 1 + p.contrast * (MAX_CLIP_LIMIT - 1),
    tileSize: Math.min(CONTRAST_TILE_CELLS * cell, MAX_TILE_SHARE * long),
    curve: p.contrast * MAX_CURVE,
    curveSigma: radius(CURVE_SIGMA_CELLS, MAX_CURVE_SIGMA_SHARE),
    edges: p.edges,
    edgeSigma: radius(EDGE_SIGMA_CELLS, MAX_EDGE_SIGMA_SHARE),
  };
}
