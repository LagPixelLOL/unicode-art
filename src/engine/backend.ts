// Compute backend contract.
//
// Everything performance sensitive goes through a ComputeBackend so a
// different implementation (for example a worker or WebGL based one) can be
// added later by implementing this interface and registering a factory in
// registry.ts. The application only ever talks to these types.

export interface FontInfoData {
  format: string;
  family: string;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  lineGap: number;
  glyphCount: number;
  isVariable: boolean;
  /** Glyphs skipped because they are drawn in color. */
  colorGlyphs: number;
  /** Sorted usable code points that map to a real glyph. */
  codepoints: Uint32Array;
  /** Advance in font units per entry of `codepoints`. */
  advances: Uint16Array;
  /** Bytes to register with the browser instead of the input (collections). */
  standalone: Uint8Array | null;
}

export interface MergedCharset {
  codepoints: Uint32Array;
  /** Highest priority font index for every code point. */
  fontIndex: Uint32Array;
}

export interface ExclusionRule {
  kind: "range" | "category" | "bidi" | "grapheme";
  key: string;
  description: string;
}

/**
 * Preprocessing of the grey image, applied in this order at the source
 * resolution, before the image is resampled. Grey values are sRGB encoded
 * brightness in [0, 1].
 */
export interface Preprocessing {
  /** Flips black and white. */
  invert: boolean;
  /**
   * Contrast limited adaptive histogram equalization (CLAHE): tiles of
   * about `tileSize` source pixels are equalized with their histograms
   * clipped at `clipLimit` times the mean bin count (the excess is spread
   * over all bins), and every pixel blends the four nearest tiles. Dark or
   * bright regions keep their detail; the limit keeps flat areas from
   * turning into noise. 1 turns it off.
   */
  clipLimit: number;
  tileSize: number;
  /**
   * S-curve after equalizing that spreads every pixel away from its local
   * mean (a Gaussian blur of `curveSigma` source pixels), with slope
   * 1 / (1 - curve) at the mean. Black, white and the mean stay, and
   * regions keep their detail since each pivots on its own mean. 0 turns it
   * off and 1 thresholds at the local mean.
   */
  curve: number;
  curveSigma: number;
  /**
   * Edge boost in [0, 1]: blends the grey image toward an outline map, so
   * flat areas fade out. The map is the gradient magnitude of a Gaussian
   * blur of `edgeSigma` source pixels (a step of height h gives h), divided
   * by its 98th percentile over the image (at least 0.05) and soft
   * thresholded between 0.1 and 0.6. The lines take the image's polarity:
   * dark on white when the mean of the blurred grey image is above one
   * half, light on black otherwise. 0 keeps the image, 1 leaves only the
   * outlines.
   */
  edges: number;
  edgeSigma: number;
}

/**
 * An image kept by the backend (on the GPU for WebGPU), so it can be
 * preprocessed again and again without being uploaded again.
 */
export interface ImageHandle {
  readonly width: number;
  readonly height: number;
  /**
   * Releases the image. Work already using it finishes normally; later
   * requests with it are rejected.
   */
  dispose(): void;
}

export interface TargetRequest {
  image: ImageHandle;
  outWidth: number;
  outHeight: number;
  preprocessing: Preprocessing;
  signal?: AbortSignal;
}

function positiveInts(...dims: number[]): boolean {
  return dims.every((d) => Number.isInteger(d) && d > 0);
}

/** Rejects images no backend can take; backends call it before uploading. */
export function checkImage(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): void {
  if (!positiveInts(width, height)) throw new Error("Image dimensions must be positive integers.");
  if (rgba.length !== width * height * 4) throw new Error("The pixel buffer does not match the image dimensions.");
}

/** Rejects requests no backend can serve; backends call it before any work. */
export function checkTargetRequest(r: TargetRequest): void {
  if (!positiveInts(r.outWidth, r.outHeight)) throw new Error("Image dimensions must be positive integers.");
  const p = r.preprocessing;
  if (!(p.clipLimit >= 1 && Number.isFinite(p.clipLimit))) throw new Error("The contrast clip limit must be a finite number of at least 1.");
  if (p.clipLimit > 1 && !(p.tileSize > 0 && Number.isFinite(p.tileSize))) throw new Error("The contrast tile size must be a positive finite number.");
  if (!(p.curve >= 0 && p.curve <= 1)) throw new Error("The contrast curve must be a number from 0 to 1.");
  if (p.curve > 0 && !(p.curveSigma > 0 && Number.isFinite(p.curveSigma))) throw new Error("The contrast curve radius must be a positive finite number.");
  if (!(p.edges >= 0 && p.edges <= 1)) throw new Error("The edge boost must be a number from 0 to 1.");
  if (p.edges > 0 && !(p.edgeSigma > 0 && Number.isFinite(p.edgeSigma))) {
    throw new Error("The edge boost radius must be a positive finite number.");
  }
}

/** One rasterized page of glyph cells. Coverage is read from the red channel. */
export interface GlyphPage {
  rgba: Uint8Array | Uint8ClampedArray;
  width: number;
  xs: Uint32Array;
  ys: Uint32Array;
  glyphs: Uint32Array;
  widths: Uint32Array;
}

export interface GlyphBankHandle {
  readonly cellH: number;
  readonly binCount: number;
  readonly maxWidth: number;
  readonly glyphCount: number;
  /** Glyphs dropped because they look exactly like another candidate. */
  readonly duplicates: number;
  dispose(): void;
}

export interface GlyphBankBuilder {
  addPage(page: GlyphPage): Promise<void>;
  build(): Promise<GlyphBankHandle>;
  /** Releases the builder without building. */
  dispose(): void;
}

export interface LayoutRequest {
  bank: GlyphBankHandle;
  /** Ink target, `rows * cellH` lines of `width` pixels. */
  target: Float32Array;
  rows: number;
  width: number;
  /** Exact advance in pixels for every glyph id. */
  advances: Float32Array;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface LayoutResult {
  glyphs: Uint32Array;
  positions: Float32Array;
  rowOffsets: Uint32Array;
  rowWidths: Float32Array;
  totalCost: number;
  /** Time spent scoring candidates and solving rows, in milliseconds. */
  ms: { score: number; solve: number };
}

export interface ImageComparison {
  pixels: number;
  absDiff: number;
  inkA: number;
  inkB: number;
  maxDiff: number;
  differing: number;
  similarity: number;
}

export interface ComputeBackend {
  readonly id: string;
  readonly label: string;
  parseFont(data: Uint8Array): Promise<FontInfoData>;
  exclusionRules(): Promise<ExclusionRule[]>;
  /** `lists[0]` has the highest priority. */
  mergeCoverage(lists: Uint32Array[]): Promise<MergedCharset>;
  /** Keeps straight alpha RGBA pixels for any number of prepareTarget calls. */
  uploadImage(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Promise<ImageHandle>;
  /**
   * Turns the image into the ink target, `outWidth * outHeight` values in
   * [0, 1]: the image is composited over white, converted to grey,
   * preprocessed, resampled in linear light and encoded as sRGB brightness.
   */
  prepareTarget(request: TargetRequest): Promise<Float32Array>;
  createGlyphBankBuilder(cellH: number): Promise<GlyphBankBuilder>;
  /** Scores every glyph at every position and solves the row layout. */
  layout(request: LayoutRequest): Promise<LayoutResult>;
  /**
   * Compares the red channel of two RGBA images `width` pixels wide, after a
   * box blur of `radius` pixels.
   */
  compareImages(
    a: Uint8Array | Uint8ClampedArray,
    b: Uint8Array | Uint8ClampedArray,
    width: number,
    threshold: number,
    radius: number,
  ): Promise<ImageComparison>;
  /** Resolves with a reason when the backend becomes unusable. */
  readonly lost: Promise<string>;
  dispose(): void;
}

export type ProbeResult = { ok: true } | { ok: false; reasons: string[] };

export interface BackendFactory {
  readonly id: string;
  readonly label: string;
  /** Checks every required browser capability without side effects. */
  probe(): Promise<ProbeResult>;
  create(): Promise<ComputeBackend>;
}

export class AbortedError extends Error {
  constructor() {
    super("Aborted");
    this.name = "AbortError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError();
}

export function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}
