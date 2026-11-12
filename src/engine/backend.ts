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
  /** Exponent applied to every grey value (1 keeps them, below 1 brightens). */
  gamma: number;
  /**
   * Edge boost as an unsharp mask: grey + amount * (grey - blurred grey),
   * clamped to [0, 1]. 0 turns it off.
   */
  edgeAmount: number;
  /** Standard deviation of the unsharp mask's Gaussian blur in source pixels. */
  edgeSigma: number;
}

export interface TargetRequest {
  /** Straight alpha RGBA pixels. */
  rgba: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  outWidth: number;
  outHeight: number;
  preprocessing: Preprocessing;
  signal?: AbortSignal;
}

/** Rejects requests no backend can serve; backends call it before any work. */
export function checkTargetRequest(r: TargetRequest): void {
  const dims = [r.width, r.height, r.outWidth, r.outHeight];
  if (!dims.every((d) => Number.isInteger(d) && d > 0)) throw new Error("Image dimensions must be positive integers.");
  if (r.rgba.length !== r.width * r.height * 4) throw new Error("The pixel buffer does not match the image dimensions.");
  const p = r.preprocessing;
  if (!(p.gamma >= 0 && Number.isFinite(p.gamma))) throw new Error("Gamma must be a finite number of at least 0.");
  if (!(p.edgeAmount >= 0 && Number.isFinite(p.edgeAmount))) throw new Error("The edge boost amount must be a finite number of at least 0.");
  if (p.edgeAmount > 0 && !(p.edgeSigma > 0 && Number.isFinite(p.edgeSigma))) {
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
