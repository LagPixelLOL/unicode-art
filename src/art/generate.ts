// Conversion pipeline: fonts + image + options -> laid out unicode text.

import type { ComputeBackend, GlyphBankHandle, LayoutResult } from "../engine/backend";
import { throwIfAborted } from "../engine/backend";
import { rasterizeGlyphs } from "./atlas";
import { type CharsetData, type FontRef, buildCharset, charsetKey } from "./charset";
import { type Geometry, type GlyphSelection, computeGeometry, rowCount, selectGlyphs } from "./geometry";

export interface ArtOptions {
  widthCells: number;
  detail: number;
  invert: boolean;
}

export interface SourceImage {
  id: number;
  name: string;
  /** Whether the image was scaled down on decoding. */
  limited: boolean;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export interface ArtResult {
  lines: string[];
  text: string;
  families: string[];
  /** Characters each font provides after priority, per family. */
  provided: number[];
  geometry: Geometry;
  rows: number;
  layout: LayoutResult;
  /** Per glyph id. */
  glyphCodepoint: Uint32Array;
  glyphFont: Uint32Array;
  glyphAdvancePx: Float32Array;
  stats: {
    candidates: number;
    duplicates: number;
    distinct: number;
    characters: number;
    rmsError: number;
    excluded: { mismatched: number; tooNarrow: number; tooWide: number };
    ms: { charset: number; glyphs: number; target: number; match: number };
    /** Steps skipped because their result was reused from the previous run. */
    cached: { charset: boolean; glyphs: boolean };
  };
}

export type Stage = "charset" | "glyphs" | "target" | "match";
export type ProgressFn = (stage: Stage, fraction: number) => void;

interface BankEntry {
  key: string;
  geometry: Geometry;
  selection: GlyphSelection;
  handle: GlyphBankHandle;
  codepoints: Uint32Array;
  fonts: Uint32Array;
}

const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));

export class ArtGenerator {
  private charset: CharsetData | null = null;
  private bank: BankEntry | null = null;

  constructor(private readonly backend: ComputeBackend) {}

  dispose(): void {
    this.bank?.handle.dispose();
    this.bank = null;
    this.charset = null;
  }

  async generate(
    fonts: readonly FontRef[],
    image: SourceImage,
    options: ArtOptions,
    signal?: AbortSignal,
    progress: ProgressFn = () => {},
  ): Promise<ArtResult> {
    if (fonts.length === 0) throw new Error("Add at least one font.");
    const ms = { charset: 0, glyphs: 0, target: 0, match: 0 };
    const cached = { charset: true, glyphs: true };

    let t = performance.now();
    const key = charsetKey(fonts);
    if (this.charset?.key !== key) {
      progress("charset", 0);
      cached.charset = false;
      this.charset = null;
      this.charset = await buildCharset(this.backend, fonts, signal, (f) => progress("charset", f));
    }
    const charset = this.charset;
    if (charset.codepoints.length === 0) throw new Error("The loaded fonts have no usable characters.");
    ms.charset = performance.now() - t;
    throwIfAborted(signal);

    t = performance.now();
    const geometry = computeGeometry({
      chEm: charset.chEm,
      ascentEm: charset.ascentEm,
      descentEm: charset.descentEm,
      detail: options.detail,
      widthCells: options.widthCells,
    });
    const bankKey = `${charset.key}|${geometry.detail}`;
    if (this.bank?.key !== bankKey) {
      this.bank?.handle.dispose();
      this.bank = null;
      cached.glyphs = false;
      this.bank = await this.buildBank(bankKey, charset, geometry, signal, (f) => progress("glyphs", f));
    }
    const bank = this.bank;
    ms.glyphs = performance.now() - t;
    throwIfAborted(signal);

    t = performance.now();
    progress("target", 0);
    const rows = rowCount(image.width, image.height, geometry);
    const target = await this.backend.prepareTarget({
      rgba: image.rgba,
      width: image.width,
      height: image.height,
      outWidth: geometry.widthPx,
      outHeight: rows * geometry.cellH,
      invert: options.invert,
    });
    ms.target = performance.now() - t;
    throwIfAborted(signal);

    t = performance.now();
    progress("match", 0);
    const layout = await this.backend.layout({
      bank: bank.handle,
      target,
      rows,
      width: geometry.widthPx,
      advances: bank.selection.advancePx,
      signal,
      onProgress: (f) => progress("match", f),
    });
    ms.match = performance.now() - t;

    const lines: string[] = [];
    const used = new Set<number>();
    for (let r = 0; r < rows; r++) {
      let s = "";
      for (let i = layout.rowOffsets[r]; i < layout.rowOffsets[r + 1]; i++) {
        const g = layout.glyphs[i];
        used.add(g);
        s += String.fromCodePoint(bank.codepoints[g]);
      }
      lines.push(s);
    }

    return {
      lines,
      text: lines.join("\n"),
      families: charset.families,
      provided: charset.perFont,
      geometry,
      rows,
      layout,
      glyphCodepoint: bank.codepoints,
      glyphFont: bank.fonts,
      glyphAdvancePx: bank.selection.advancePx,
      stats: {
        candidates: bank.handle.glyphCount,
        duplicates: bank.handle.duplicates,
        distinct: used.size,
        characters: layout.glyphs.length,
        rmsError: Math.sqrt(layout.totalCost / Math.max(1, geometry.widthPx * rows * geometry.cellH)),
        excluded: {
          mismatched: charset.mismatched,
          tooNarrow: bank.selection.tooNarrow,
          tooWide: bank.selection.tooWide,
        },
        ms,
        cached,
      },
    };
  }

  private async buildBank(
    key: string,
    charset: CharsetData,
    geometry: Geometry,
    signal: AbortSignal | undefined,
    progress: (f: number) => void,
  ): Promise<BankEntry> {
    const selection = selectGlyphs(charset.advanceEm, geometry);
    const n = selection.charsetIndex.length;
    if (n === 0) throw new Error("No character has a usable width at this detail level.");
    const codepoints = Uint32Array.from(selection.charsetIndex, (i) => charset.codepoints[i]);
    const fonts = Uint32Array.from(selection.charsetIndex, (i) => charset.fontIndex[i]);
    const builder = await this.backend.createGlyphBankBuilder(geometry.cellH);
    let done = 0;
    progress(0);
    try {
      for await (const page of rasterizeGlyphs({
        codepoints,
        families: Array.from(fonts, (f) => charset.families[f]),
        widths: selection.widths,
        fontPx: geometry.fontPx,
        cellH: geometry.cellH,
        baselinePx: geometry.baselinePx,
      })) {
        throwIfAborted(signal);
        await builder.addPage(page);
        done += page.glyphs.length;
        progress(done / n);
        await yieldToBrowser();
      }
    } catch (e) {
      builder.dispose();
      throw e;
    }
    const handle = await builder.build();
    return { key, geometry, selection, handle, codepoints, fonts };
  }
}
