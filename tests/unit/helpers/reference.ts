// CPU oracle for the GPU matcher and helpers to build random problems.

import type { PackedBank } from "../../../src/engine/webgpu-wasm/matcher";
import type { loadCore } from "./core";

export const INVALID = 3.0e38;
const PAD = 0xffffffff;

/** Deterministic pseudo random numbers in [0, 1). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Problem {
  packed: PackedBank;
  target: Float32Array;
  rows: number;
  width: number;
  advances: Float32Array;
}

/** Random glyphs of the given widths packed by the real WASM bank builder. */
export function randomProblem(
  core: ReturnType<typeof loadCore>,
  opts: { seed: number; widths: number[]; cellH: number; rows: number; width: number },
): Problem {
  const rand = rng(opts.seed);
  const { cellH, widths } = opts;
  const pageW = widths.reduce((s, w) => s + w, 0);
  const rgba = new Uint8Array(pageW * cellH * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba[i] = Math.floor(rand() * 256);
  const xs: number[] = [];
  let x = 0;
  for (const w of widths) {
    xs.push(x);
    x += w;
  }
  const builder = new core.GlyphBankBuilder(cellH);
  builder.addPage(
    rgba,
    pageW,
    Uint32Array.from(xs),
    new Uint32Array(widths.length),
    Uint32Array.from(widths.keys()),
    Uint32Array.from(widths),
  );
  const bank = builder.build();
  const packed: PackedBank = {
    cellH: bank.cellH,
    maxWidth: bank.maxWidth,
    maxGroupCount: bank.maxGroupCount,
    binCount: bank.binCount,
    bins: bank.bins(),
    data: bank.data(),
    norms: bank.norms(),
    slotGlyph: bank.slotGlyph(),
    duplicates: bank.duplicates,
  };
  bank.free();
  const target = Float32Array.from({ length: opts.rows * cellH * opts.width }, () => rand());
  // Advances close to the matching widths, some fractional.
  const advances = Float32Array.from(widths, (w) => w + (rand() - 0.5) * 0.8);
  return { packed, target, rows: opts.rows, width: opts.width, advances };
}

/** Squared error of every glyph against every position, best per bin. */
export function referenceScores(p: Problem): { costs: Float32Array; slots: Uint32Array } {
  const { packed, target, rows, width } = p;
  const nb = packed.binCount;
  const h = packed.cellH;
  const costs = new Float32Array(rows * width * nb).fill(INVALID);
  const slots = new Uint32Array(rows * width * nb).fill(PAD);
  for (let b = 0; b < nb; b++) {
    const [w, groupOffset, groupCount, dataOffset] = packed.bins.subarray(b * 4, b * 4 + 4);
    for (let r = 0; r < rows; r++) {
      for (let s = 0; s + w <= width; s++) {
        const o = (r * width + s) * nb + b;
        for (let g = 0; g < groupCount; g++) {
          for (let lane = 0; lane < 4; lane++) {
            const slot = (groupOffset + g) * 4 + lane;
            if (packed.slotGlyph[slot] === PAD) continue;
            let sum = 0;
            for (let y = 0; y < h; y++) {
              for (let x = 0; x < w; x++) {
                const word = packed.data[dataOffset + g * w * h + y * w + x];
                const gv = ((word >>> (lane * 8)) & 255) / 255;
                const t = target[(r * h + y) * width + s + x];
                sum += (gv - t) * (gv - t);
              }
            }
            if (sum < costs[o]) {
              costs[o] = sum;
              slots[o] = slot;
            }
          }
        }
      }
    }
  }
  return { costs, slots };
}
