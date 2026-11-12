// CPU oracles for the GPU passes and helpers to build random problems.

import type { Preprocessing } from "../../../src/engine/backend";
import type { PackedBank } from "../../../src/engine/webgpu-wasm/matcher";
import { planBlur, planTiles } from "../../../src/engine/webgpu-wasm/plan";
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

/** S-curve of the contrast boost around the local mean `m` (see target.wgsl). */
export function contrastCurve(v: number, m0: number, c: number): number {
  if (c <= 0) return v;
  const m = Math.min(1 - 1e-6, Math.max(1e-6, m0));
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

/** Contrast limited adaptive histogram equalization (see target.wgsl). */
export function referenceEqualize(grey: Float64Array, w: number, h: number, clipLimit: number, tileSize: number): Float64Array {
  const BINS = 256;
  const tiles = planTiles(w, h, tileSize);
  const start = (i: number, n: number, size: number) => Math.floor((i * size) / n);
  const luts: Float64Array[] = [];
  for (let ty = 0; ty < tiles.y; ty++) {
    for (let tx = 0; tx < tiles.x; tx++) {
      const hist = new Float64Array(BINS);
      let n = 0;
      for (let y = start(ty, tiles.y, h); y < start(ty + 1, tiles.y, h); y++) {
        for (let x = start(tx, tiles.x, w); x < start(tx + 1, tiles.x, w); x++, n++) {
          hist[Math.min(Math.floor(grey[y * w + x] * BINS), BINS - 1)]++;
        }
      }
      const cap = (clipLimit * n) / BINS;
      const excess = hist.reduce((sum, c) => sum + Math.max(0, c - cap), 0);
      const lut = new Float64Array(BINS + 1);
      for (let b = 0; b < BINS; b++) lut[b + 1] = lut[b] + (Math.min(hist[b], cap) + excess / BINS) / n;
      luts.push(lut);
    }
  }
  const lookup = (tile: number, v: number) => {
    const pos = Math.min(1, Math.max(0, v)) * BINS;
    const b = Math.min(Math.floor(pos), BINS - 1);
    return luts[tile][b] + (luts[tile][b + 1] - luts[tile][b]) * (pos - b);
  };
  const tw = w / tiles.x;
  const th = h / tiles.y;
  return grey.map((v, i) => {
    const fx = Math.min(tiles.x - 1, Math.max(0, ((i % w) + 0.5) / tw - 0.5));
    const fy = Math.min(tiles.y - 1, Math.max(0, (Math.floor(i / w) + 0.5) / th - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, tiles.x - 1);
    const y1 = Math.min(y0 + 1, tiles.y - 1);
    const at = (tx: number, ty: number) => lookup(ty * tiles.x + tx, v);
    const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * (fx - x0);
    const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * (fx - x0);
    return top + (bottom - top) * (fy - y0);
  });
}

/** Grey values of the image after flip and contrast boost (see target.wgsl). */
export function referenceGrey(r: OracleRequest): Float64Array {
  const { invert, clipLimit, tileSize, curve } = r.preprocessing;
  let grey: Float64Array = new Float64Array(r.width * r.height);
  for (let i = 0; i < grey.length; i++) {
    const a = r.rgba[i * 4 + 3];
    const ch = (k: number) => srgbToLinear(Math.floor((r.rgba[i * 4 + k] * a + 255 * (255 - a) + 127) / 255) / 255);
    const v = linearToSrgb(0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2));
    grey[i] = invert ? 1 - v : v;
  }
  if (clipLimit > 1) grey = referenceEqualize(grey, r.width, r.height, clipLimit, tileSize);
  if (curve <= 0) return grey;
  const mean = referenceBlur(grey, r.width, r.height, r.preprocessing.curveSigma);
  return grey.map((v, i) => contrastCurve(v, mean[i], curve));
}

interface RefGrid {
  values: Float64Array;
  w: number;
  h: number;
  step: number;
}

/** A blur of `sigma` on the coarse grid (see planBlur and target.wgsl). */
export function referenceGrid(grey: Float64Array, w: number, h: number, sigma: number): RefGrid {
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
      for (let y = Math.max(0, Math.floor(cy - step) + 1); y < Math.min(h, Math.ceil(cy + step)); y++) {
        for (let x = Math.max(0, Math.floor(cx - step) + 1); x < Math.min(w, Math.ceil(cx + step)); x++) {
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
  return { values: grid, w: gw, h: gh, step };
}

/** Grid values at every pixel, interpolated linearly. */
export function sampleGrid(g: RefGrid, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const v = Math.min(g.h - 1, Math.max(0, (y + 0.5) / g.step - 0.5));
    const y0 = Math.floor(v);
    const y1 = Math.min(y0 + 1, g.h - 1);
    for (let x = 0; x < w; x++) {
      const u = Math.min(g.w - 1, Math.max(0, (x + 0.5) / g.step - 0.5));
      const x0 = Math.floor(u);
      const x1 = Math.min(x0 + 1, g.w - 1);
      const at = (xx: number, yy: number) => g.values[yy * g.w + xx];
      const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * (u - x0);
      const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * (u - x0);
      out[y * w + x] = top + (bottom - top) * (v - y0);
    }
  }
  return out;
}

/** The coarse grid blur sampled at every pixel. */
export function referenceBlur(grey: Float64Array, w: number, h: number, sigma: number): Float64Array {
  return sampleGrid(referenceGrid(grey, w, h, sigma), w, h);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** The edge map edge boosting is guided by, and the image's polarity (see target.wgsl). */
export function referenceOutlines(grey: Float64Array, w: number, h: number, sigma: number): { edge: Float64Array; light: boolean } {
  const g = referenceGrid(grey, w, h, sigma);
  const at = (x: number, y: number) => g.values[y * g.w + x];
  const magnitude = new Float64Array(g.values.length);
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const [xl, xr, yl, yr] = [Math.max(x - 1, 0), Math.min(x + 1, g.w - 1), Math.max(y - 1, 0), Math.min(y + 1, g.h - 1)];
      const gx = xr > xl ? (at(xr, y) - at(xl, y)) / ((xr - xl) * g.step) : 0;
      const gy = yr > yl ? (at(x, yr) - at(x, yl)) / ((yr - yl) * g.step) : 0;
      magnitude[y * g.w + x] = Math.hypot(gx, gy) * sigma * Math.sqrt(2 * Math.PI);
    }
  }
  const hist = new Float64Array(256);
  for (const m of magnitude) hist[Math.min(Math.floor(m * 256), 255)]++;
  let level = 1;
  for (let b = 0, sum = 0; b < 256; b++) {
    sum += hist[b];
    if (sum >= 0.98 * magnitude.length) {
      level = (b + 1) / 256;
      break;
    }
  }
  level = Math.max(level, 0.05);
  const light = g.values.reduce((sum, v) => sum + v, 0) / g.values.length > 0.5;
  return { edge: sampleGrid({ ...g, values: magnitude }, w, h).map((m) => smoothstep(0.1, 0.6, m / level)), light };
}

/** Edge boosting of `grey` with strength `s` (see target.wgsl). */
export function referenceEdgeBoost(grey: Float64Array, w: number, h: number, s: number, sigma: number): Float64Array {
  const { edge, light } = referenceOutlines(grey, w, h, sigma);
  const background = light ? 1 : 0;
  const fade = Math.min(1, s / 0.6);
  const t = smoothstep(0.6, 1, s);
  return grey.map((v, i) => {
    const kept = background + (v - background) * (1 - fade * (1 - edge[i]));
    const line = light ? 1 - edge[i] : edge[i];
    return kept + (line - kept) * t;
  });
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
  const { edges, edgeSigma } = r.preprocessing;
  const grey = referenceGrey(r);
  const boosted = edges > 0 ? referenceEdgeBoost(grey, r.width, r.height, edges, edgeSigma) : grey;
  const lin = boosted.map(srgbToLinear);
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
