// CPU oracles for the GPU passes and helpers to build random problems.

import type { Preprocessing } from "../../../src/engine/backend";
import type { PackedBank } from "../../../src/engine/webgpu-wasm/matcher";
import { planBlur } from "../../../src/engine/webgpu-wasm/plan";
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

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(v: number): number {
  const c = Math.min(1, Math.max(0, v));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** S-curve of the contrast boost around the mean grey `m` (see target.wgsl). */
export function contrastCurve(v: number, m: number, c: number): number {
  if (c <= 0 || m <= 0 || m >= 1) return v;
  if (c >= 1) return v < m ? 0 : v === m ? m : 1;
  const k = 1 / (1 - c);
  return v < m ? m * (v / m) ** k : 1 - (1 - m) * ((1 - v) / (1 - m)) ** k;
}

/** What the target oracle needs: the pixels themselves instead of a handle. */
export interface OracleRequest {
  rgba: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  outWidth: number;
  outHeight: number;
  preprocessing: Preprocessing;
}

/** Grey values of the image after flip and contrast boost (see target.wgsl). */
export function referenceGrey(r: OracleRequest): Float64Array {
  const { invert, contrast } = r.preprocessing;
  const grey = new Float64Array(r.width * r.height);
  for (let i = 0; i < grey.length; i++) {
    const a = r.rgba[i * 4 + 3];
    const ch = (k: number) => srgbToLinear(Math.floor((r.rgba[i * 4 + k] * a + 255 * (255 - a) + 127) / 255) / 255);
    const v = linearToSrgb(0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2));
    grey[i] = invert ? 1 - v : v;
  }
  const mean = grey.reduce((s, v) => s + v, 0) / grey.length;
  return grey.map((v) => contrastCurve(v, mean, contrast));
}

/** The unsharp mask's blur on the coarse grid, sampled at every pixel. */
export function referenceBlur(grey: Float64Array, w: number, h: number, sigma: number): Float64Array {
  const { step, sigma: gs, radius } = planBlur(sigma);
  const gw = Math.ceil(w / step);
  const gh = Math.ceil(h / step);
  let grid = new Float64Array(gw * gh);
  const tent = (d: number) => Math.max(0, 1 - Math.abs(d) / step);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const cx = (gx + 0.5) * step - 0.5;
      const cy = (gy + 0.5) * step - 0.5;
      let sum = 0;
      let total = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const wt = tent(x - cx) * tent(y - cy);
          sum += wt * grey[y * w + x];
          total += wt;
        }
      }
      grid[gy * gw + gx] = sum / total;
    }
  }
  const pass = (dx: number, dy: number) => {
    const next = new Float64Array(grid.length);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let sum = 0;
        let total = 0;
        for (let k = -radius; k <= radius; k++) {
          const wk = Math.exp(-0.5 * (k / gs) ** 2);
          const x = Math.min(gw - 1, Math.max(0, gx + k * dx));
          const y = Math.min(gh - 1, Math.max(0, gy + k * dy));
          sum += wk * grid[y * gw + x];
          total += wk;
        }
        next[gy * gw + gx] = sum / total;
      }
    }
    grid = next;
  };
  pass(1, 0);
  pass(0, 1);
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const v = Math.min(gh - 1, Math.max(0, (y + 0.5) / step - 0.5));
    const y0 = Math.floor(v);
    const y1 = Math.min(y0 + 1, gh - 1);
    for (let x = 0; x < w; x++) {
      const u = Math.min(gw - 1, Math.max(0, (x + 0.5) / step - 0.5));
      const x0 = Math.floor(u);
      const x1 = Math.min(x0 + 1, gw - 1);
      const top = grid[y0 * gw + x0] + (grid[y0 * gw + x1] - grid[y0 * gw + x0]) * (u - x0);
      const bottom = grid[y1 * gw + x0] + (grid[y1 * gw + x1] - grid[y1 * gw + x0]) * (u - x0);
      out[y * w + x] = top + (bottom - top) * (v - y0);
    }
  }
  return out;
}

/** Source pixels and normalized weights per output sample along one axis. */
function referenceTaps(n: number, m: number): { first: number; weights: number[] }[] {
  const scale = n / m;
  return Array.from({ length: m }, (_, o) => {
    if (scale >= 1) {
      const lo = o * scale;
      const hi = Math.min((o + 1) * scale, n);
      const first = Math.min(Math.floor(lo), n - 1);
      const last = Math.max(Math.min(Math.ceil(hi), n), first + 1);
      const weights = Array.from({ length: last - first }, (_, k) => Math.max(0, Math.min(first + k + 1, hi) - Math.max(first + k, lo)));
      const sum = weights.reduce((s, x) => s + x, 0);
      return { first, weights: weights.map((x) => x / sum) };
    }
    const c = Math.min(n - 1, Math.max(0, (o + 0.5) * scale - 0.5));
    const first = Math.floor(c);
    const t = c - first;
    return { first, weights: first + 1 < n && t > 0 ? [1 - t, t] : [1] };
  });
}

/** CPU oracle of the whole target preparation. */
export function referenceTarget(r: OracleRequest): Float32Array {
  const { edgeAmount, edgeSigma } = r.preprocessing;
  const grey = referenceGrey(r);
  const blurred = edgeAmount > 0 ? referenceBlur(grey, r.width, r.height, edgeSigma) : null;
  const lin = grey.map((v, i) => srgbToLinear(blurred ? Math.min(1, Math.max(0, v + edgeAmount * (v - blurred[i]))) : v));
  const tx = referenceTaps(r.width, r.outWidth);
  const ty = referenceTaps(r.height, r.outHeight);
  const out = new Float32Array(r.outWidth * r.outHeight);
  for (let oy = 0; oy < r.outHeight; oy++) {
    for (let ox = 0; ox < r.outWidth; ox++) {
      let sum = 0;
      ty[oy].weights.forEach((wy, ky) => {
        tx[ox].weights.forEach((wx, kx) => {
          sum += wy * wx * lin[(ty[oy].first + ky) * r.width + tx[ox].first + kx];
        });
      });
      out[oy * r.outWidth + ox] = linearToSrgb(sum);
    }
  }
  return out;
}
