// WebGPU + WebAssembly implementation of ComputeBackend.
//
// WASM (Rust) handles font parsing, image preparation, glyph packing,
// layout solving and image comparison; WebGPU scores every glyph against
// every position.

import type {
  ComputeBackend,
  ExclusionRule,
  FontInfoData,
  GlyphBankBuilder,
  GlyphBankHandle,
  GlyphPage,
  ImageComparison,
  LayoutRequest,
  LayoutResult,
  MergedCharset,
  TargetRequest,
} from "../backend";
import { throwIfAborted } from "../backend";
import type { Core } from "./core";
import { GpuBank, Matcher } from "./matcher";

function bytes(a: Uint8Array | Uint8ClampedArray): Uint8Array {
  return a instanceof Uint8Array ? a : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

class BankHandle implements GlyphBankHandle {
  constructor(readonly gpu: GpuBank) {}
  get cellH() {
    return this.gpu.packed.cellH;
  }
  get binCount() {
    return this.gpu.packed.binCount;
  }
  get maxWidth() {
    return this.gpu.packed.maxWidth;
  }
  get duplicates() {
    return this.gpu.packed.duplicates;
  }
  get glyphCount() {
    let n = 0;
    for (const g of this.gpu.packed.slotGlyph) if (g !== 0xffffffff) n++;
    return n;
  }
  dispose() {
    this.gpu.dispose();
  }
}

export class WebGpuWasmBackend implements ComputeBackend {
  readonly id = "webgpu-wasm";
  readonly label = "WebGPU + WebAssembly";
  readonly lost: Promise<string>;
  private readonly matcher: Matcher;

  constructor(
    private readonly core: Core,
    private readonly device: GPUDevice,
  ) {
    this.matcher = new Matcher(device);
    this.lost = device.lost.then((info) => `The GPU device was lost (${info.reason}): ${info.message}`);
  }

  async parseFont(data: Uint8Array): Promise<FontInfoData> {
    const info = this.core.parseFont(data);
    try {
      return {
        format: info.format,
        family: info.family,
        unitsPerEm: info.unitsPerEm,
        ascender: info.ascender,
        descender: info.descender,
        lineGap: info.lineGap,
        glyphCount: info.glyphCount,
        isVariable: info.isVariable,
        colorGlyphs: info.colorGlyphs,
        codepoints: info.codepoints(),
        advances: info.advances(),
        standalone: info.format === "ttc" ? info.standalone() : null,
      };
    } finally {
      info.free();
    }
  }

  async exclusionRules(): Promise<ExclusionRule[]> {
    return this.core
      .exclusionRules()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [kind, key, description] = line.split("\t");
        return { kind: kind as ExclusionRule["kind"], key, description };
      });
  }

  async mergeCoverage(lists: Uint32Array[]): Promise<MergedCharset> {
    const total = lists.reduce((s, l) => s + l.length, 0);
    const all = new Uint32Array(total);
    let at = 0;
    for (const l of lists) {
      all.set(l, at);
      at += l.length;
    }
    const merged = this.core.mergeCoverage(all, new Uint32Array(lists.map((l) => l.length)));
    try {
      return { codepoints: merged.codepoints(), fontIndex: merged.fontIndex() };
    } finally {
      merged.free();
    }
  }

  async prepareTarget(r: TargetRequest): Promise<Float32Array> {
    return this.core.prepareTarget(bytes(r.rgba), r.width, r.height, r.outWidth, r.outHeight, r.invert);
  }

  async createGlyphBankBuilder(cellH: number): Promise<GlyphBankBuilder> {
    const builder = new this.core.GlyphBankBuilder(cellH);
    const device = this.device;
    let built = false;
    return {
      async addPage(p: GlyphPage) {
        builder.addPage(bytes(p.rgba), p.width, p.xs, p.ys, p.glyphs, p.widths);
      },
      async build() {
        if (built) throw new Error("Glyph bank already built");
        built = true;
        const bank = builder.build();
        try {
          if (bank.binCount === 0) throw new Error("No usable glyphs to match against.");
          const gpu = new GpuBank(device, {
            cellH: bank.cellH,
            maxWidth: bank.maxWidth,
            maxGroupCount: bank.maxGroupCount,
            binCount: bank.binCount,
            bins: bank.bins(),
            data: bank.data(),
            norms: bank.norms(),
            slotGlyph: bank.slotGlyph(),
            duplicates: bank.duplicates,
          });
          return new BankHandle(gpu);
        } finally {
          bank.free();
        }
      },
      dispose() {
        if (!built) builder.free();
        built = true;
      },
    };
  }

  async layout(req: LayoutRequest): Promise<LayoutResult> {
    if (!(req.bank instanceof BankHandle)) throw new Error("Glyph bank belongs to another backend");
    const bank = req.bank.gpu;
    const { cellH, binCount, slotGlyph } = bank.packed;
    const parts: LayoutResult[] = [];
    const ms = { score: 0, solve: 0 };
    let t = performance.now();
    for await (const batch of this.matcher.score(bank, req.target, req.rows, req.width, req.signal, req.onProgress)) {
      throwIfAborted(req.signal);
      const solveStart = performance.now();
      ms.score += solveStart - t;
      const slice = req.target.subarray(
        batch.rowStart * cellH * req.width,
        (batch.rowStart + batch.rowCount) * cellH * req.width,
      );
      const layout = this.core.solveLayout(
        batch.rowCount,
        req.width,
        binCount,
        cellH,
        batch.costs,
        batch.slots,
        slotGlyph,
        req.advances,
        slice,
      );
      try {
        parts.push({
          glyphs: layout.glyphs(),
          positions: layout.positions(),
          rowOffsets: layout.rowOffsets(),
          rowWidths: layout.rowWidths(),
          totalCost: layout.totalCost,
          ms: { score: 0, solve: 0 },
        });
      } finally {
        layout.free();
      }
      t = performance.now();
      ms.solve += t - solveStart;
    }
    return { ...concatLayouts(parts), ms };
  }

  async compareImages(
    a: Uint8Array | Uint8ClampedArray,
    b: Uint8Array | Uint8ClampedArray,
    width: number,
    threshold: number,
    radius: number,
  ): Promise<ImageComparison> {
    const [pixels, absDiff, inkA, inkB, maxDiff, differing, similarity] = this.core.compareRgba(
      bytes(a),
      bytes(b),
      width,
      threshold,
      radius,
    );
    return { pixels, absDiff, inkA, inkB, maxDiff, differing, similarity };
  }

  dispose(): void {
    this.device.destroy();
  }
}

export function concatLayouts(parts: LayoutResult[]): LayoutResult {
  const n = parts.reduce((s, p) => s + p.glyphs.length, 0);
  const rows = parts.reduce((s, p) => s + p.rowWidths.length, 0);
  const out: LayoutResult = {
    glyphs: new Uint32Array(n),
    positions: new Float32Array(n),
    rowOffsets: new Uint32Array(rows + 1),
    rowWidths: new Float32Array(rows),
    totalCost: 0,
    ms: { score: 0, solve: 0 },
  };
  let g = 0;
  let r = 0;
  for (const p of parts) {
    out.glyphs.set(p.glyphs, g);
    out.positions.set(p.positions, g);
    out.rowWidths.set(p.rowWidths, r);
    for (let i = 1; i < p.rowOffsets.length; i++) out.rowOffsets[r + i] = p.rowOffsets[i] + g;
    g += p.glyphs.length;
    r += p.rowWidths.length;
    out.totalCost += p.totalCost;
    out.ms.score += p.ms.score;
    out.ms.solve += p.ms.solve;
  }
  return out;
}
