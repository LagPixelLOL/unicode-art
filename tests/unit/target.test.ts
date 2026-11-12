// Ink target preparation: the WGSL passes on native WebGPU (Dawn) against
// the CPU oracle, and the semantics of every preprocessing step.

import { describe, expect, it } from "vitest";
import { type Preprocessing, isAbort } from "../../src/engine/backend";
import { WebGpuWasmBackend } from "../../src/engine/webgpu-wasm/backend";
import { planBlur } from "../../src/engine/webgpu-wasm/plan";
import { TargetPreparer } from "../../src/engine/webgpu-wasm/target";
import { loadCore } from "./helpers/core";
import { requireGpuNotice } from "./helpers/gpu";
import { type OracleRequest, contrastCurve, referenceBlur, referenceTarget, rng } from "./helpers/reference";

const device = await requireGpuNotice();
const PLAIN: Preprocessing = { invert: false, clipLimit: 1, tileSize: 16, curve: 0, curveSigma: 4, edges: 0, edgeSigma: 1 };

function solid(w: number, h: number, px: number[]): Uint8Array {
  return Uint8Array.from({ length: w * h * 4 }, (_, i) => px[i % 4]);
}

function noise(w: number, h: number, seed: number): Uint8Array {
  const rand = rng(seed);
  return Uint8Array.from({ length: w * h * 4 }, () => Math.floor(rand() * 256));
}

type Request = OracleRequest & { signal?: AbortSignal };

function request(rgba: Uint8Array, w: number, h: number, outW: number, outH: number, pre: Partial<Preprocessing> = {}): Request {
  return { rgba, width: w, height: h, outWidth: outW, outHeight: outH, preprocessing: { ...PLAIN, ...pre } };
}

/** Uploads, prepares and releases the image with `preparer`. */
async function prepareWith(preparer: TargetPreparer, r: Request): Promise<Float32Array> {
  const image = preparer.upload(r.rgba, r.width, r.height);
  try {
    return await preparer.prepare({ image, outWidth: r.outWidth, outHeight: r.outHeight, preprocessing: r.preprocessing, signal: r.signal });
  } finally {
    image.dispose();
  }
}

/** Mean step between neighbouring columns 4 to 28 of row 16 (the stripes). */
function stripes(out: Float32Array, w: number): number {
  let sum = 0;
  for (let x = 4; x < 28; x++) sum += Math.abs(out[16 * w + x] - out[16 * w + x + 1]);
  return sum / 24;
}

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  expect(a.length).toBe(b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe("blur plan", () => {
  it("blurs on the full grid when narrow and on a coarse grid that keeps the spread otherwise", () => {
    expect(planBlur(1.5)).toEqual({ step: 1, sigma: 1.5, radius: 5 });
    for (const sigma of [4, 7.3, 20]) {
      const p = planBlur(sigma);
      expect(p.step).toBe(Math.floor(sigma / 2));
      expect(p.sigma).toBeGreaterThan(1.8);
      expect(p.radius).toBe(Math.ceil(3 * p.sigma));
    }
    expect(() => planBlur(0)).toThrow(/sigma/);
    expect(() => planBlur(Number.NaN)).toThrow(/sigma/);
  });

  it("approximates a true Gaussian of the requested sigma", () => {
    // A white line on black, blurred across: compare with the exact profile.
    const w = 160;
    const grey = Float64Array.from({ length: w * 3 }, (_, i) => (i % w === 80 ? 1 : 0));
    for (const sigma of [6, 11]) {
      const got = referenceBlur(grey, w, 3, sigma).subarray(w, 2 * w);
      let mass = 0;
      let mean = 0;
      for (let x = 0; x < w; x++) mass += got[x];
      for (let x = 0; x < w; x++) mean += (got[x] * (x - 80)) / mass;
      let variance = 0;
      for (let x = 0; x < w; x++) variance += (got[x] * (x - 80 - mean) ** 2) / mass;
      expect(mass).toBeCloseTo(1, 1);
      expect(Math.abs(mean)).toBeLessThan(1);
      expect(Math.sqrt(variance) / sigma).toBeGreaterThan(0.93);
      expect(Math.sqrt(variance) / sigma).toBeLessThan(1.07);
    }
  });
});

describe.skipIf(!device)("WebGPU target preparation", () => {
  const backend = new WebGpuWasmBackend(loadCore(), device!);
  const prepare = async (r: Request) => {
    const image = await backend.uploadImage(r.rgba, r.width, r.height);
    try {
      return await backend.prepareTarget({ image, outWidth: r.outWidth, outHeight: r.outHeight, preprocessing: r.preprocessing, signal: r.signal });
    } finally {
      image.dispose();
    }
  };

  it("composites over white, converts to grey and resamples", async () => {
    const rgba = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
    expect([...(await prepare(request(rgba, 2, 2, 2, 2)))].map((v) => +v.toFixed(3))).toEqual([1, 0, 1, 0]);
    expect((await prepare(request(solid(3, 2, [0, 0, 0, 0]), 3, 2, 3, 2, { invert: true }))).every((v) => Math.abs(v) < 2e-3)).toBe(true);
    const one = async (px: number[], pre: Partial<Preprocessing> = {}) => (await prepare(request(solid(1, 1, px), 1, 1, 1, 1, pre)))[0];
    expect(await one([0, 0, 0, 255])).toBeCloseTo(0, 3);
    // Pure green is far brighter than pure blue; grey stays the same grey.
    expect(await one([0, 255, 0, 255])).toBeGreaterThan(0.8);
    expect(await one([0, 0, 255, 255])).toBeLessThan(0.4);
    expect(await one([128, 128, 128, 255])).toBeCloseTo(128 / 255, 3);
    // Half transparent black over white is a mid grey.
    expect(await one([0, 0, 0, 128])).toBeCloseTo(127 / 255, 3);
  });

  it("downscales in linear light and flips the grey image, not the result", async () => {
    // A black and white checkerboard averages to 50% linear light (about
    // 0.735 in sRGB); flipped it is still a checkerboard.
    const board = new Uint8Array(64);
    for (let i = 0; i < 16; i++) {
      const v = ((i % 4) + Math.floor(i / 4)) % 2 === 0 ? 255 : 0;
      board.set([v, v, v, 255], i * 4);
    }
    for (const invert of [false, true]) {
      const out = await prepare(request(board, 4, 4, 2, 2, { invert }));
      expect(out.every((v) => Math.abs(v - 0.7354) < 1e-3)).toBe(true);
    }
    // Non integer factors keep a uniform image uniform.
    const out = await prepare(request(solid(7, 5, [200, 200, 200, 255]), 7, 5, 3, 2));
    expect(out.every((v) => Math.abs(v - 200 / 255) < 2e-3)).toBe(true);
  });

  it("upscales by interpolation and keeps the orientation", async () => {
    const img = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]);
    const out = await prepare(request(img, 2, 1, 8, 2));
    const inv = await prepare(request(img, 2, 1, 8, 2, { invert: true }));
    for (let r = 0; r < 2; r++) {
      const row = out.subarray(r * 8, r * 8 + 8);
      expect(row[0]).toBeCloseTo(0, 3);
      expect(row[7]).toBeCloseTo(1, 3);
      for (let x = 1; x < 8; x++) expect(row[x]).toBeGreaterThanOrEqual(row[x - 1] - 1e-6);
      // Flipped, the image is its own mirror.
      for (let x = 0; x < 8; x++) expect(inv[r * 8 + x]).toBeCloseTo(row[7 - x], 4);
    }
  });

  it("applies the S-curve around the local mean, keeping black and white", async () => {
    const levels = [0, 64, 100, 192, 255];
    const greys = Uint8Array.from(levels.flatMap((c) => [c, c, c, 255]));
    // A radius far beyond the image: every pixel's local mean is about the mean.
    const mean = referenceBlur(Float64Array.from(levels, (c) => c / 255), 5, 1, 1000);
    const at = async (curve: number, invert = false) =>
      [...(await prepare(request(greys, 5, 1, 5, 1, { curve, curveSigma: 1000, invert })))];
    const plain = await at(0);
    for (const [i, c] of levels.entries()) expect(plain[i]).toBeCloseTo(c / 255, 3);
    const half = await at(0.5);
    for (const [i, c] of levels.entries()) expect(half[i]).toBeCloseTo(contrastCurve(c / 255, mean[i], 0.5), 3);
    expect([half[0], half[4]]).toEqual([plain[0], plain[4]]);
    // Darker below the mean, brighter above it, more so with a stronger boost.
    const strong = await at(0.9);
    expect(strong[1]).toBeLessThan(half[1]);
    expect(half[1]).toBeLessThan(plain[1]);
    expect(strong[3]).toBeGreaterThan(half[3]);
    expect(half[3]).toBeGreaterThan(plain[3]);
    // 1 leaves only black and white.
    expect((await at(1)).map((v) => +v.toFixed(3))).toEqual([0, 0, 0, 1, 1]);
    // The curve follows the flip: flipped input gives the flipped result.
    const flipped = await at(0.5, true);
    for (let i = 0; i < 5; i++) expect(flipped[i]).toBeCloseTo(1 - half[i], 3);
  });

  it("pivots the S-curve on the local mean, so every region keeps its detail", async () => {
    // Faint dark stripes (strokes on a black glove) next to a bright area.
    const w = 64;
    const rgba = new Uint8Array(w * 32 * 4);
    for (let i = 0; i < w * 32; i++) {
      const c = i % w < 32 ? (i % 2 ? 50 : 30) : 230;
      rgba.set([c, c, c, 255], i * 4);
    }
    const at = (pre: Partial<Preprocessing>) => prepare(request(rgba, w, 32, w, 32, pre));
    const plain = await at({});
    // Pivoting on the mean of the whole image crushes the stripes, a local
    // pivot spreads them, and the dark area stays dark.
    const wide = await at({ curve: 0.75, curveSigma: 1000 });
    const local = await at({ curve: 0.75, curveSigma: 4 });
    expect(stripes(wide, w)).toBeLessThan(0.5 * stripes(plain, w));
    expect(stripes(local, w)).toBeGreaterThan(2 * stripes(plain, w));
    expect(local[16 * w + 10]).toBeLessThan(0.3);
    expect(local[16 * w + 54]).toBeGreaterThan(0.85);
    // A uniform image has nothing to spread.
    const flat = await prepare(request(solid(9, 7, [77, 77, 77, 255]), 9, 7, 3, 2, { curve: 0.8 }));
    expect(flat.every((v) => Math.abs(v - 77 / 255) < 2e-3)).toBe(true);
    expect((await prepare(request(solid(2, 2, [0, 0, 0, 255]), 2, 2, 1, 1, { curve: 1 })))[0]).toBeCloseTo(0, 4);
  });

  it("equalizes tile by tile, so dark regions keep their detail", async () => {
    // A dark region of faint stripes (like strokes on a black glove) next to
    // a bright one.
    const w = 64;
    const rgba = new Uint8Array(w * 32 * 4);
    for (let i = 0; i < w * 32; i++) {
      const x = i % w;
      const c = x < 32 ? (x % 2 ? 50 : 30) : 230;
      rgba.set([c, c, c, 255], i * 4);
    }
    const at = (pre: Partial<Preprocessing>) => prepare(request(rgba, w, 32, w, 32, { tileSize: 32, ...pre }));
    const plain = await at({});
    const equalized = await at({ clipLimit: 16 });
    const both = await at({ clipLimit: 16, curve: 0.75, curveSigma: 4 });
    expect(stripes(equalized, w)).toBeGreaterThan(1.5 * stripes(plain, w));
    expect(stripes(both, w)).toBeGreaterThan(2 * stripes(plain, w));
    // The dark region stays darker than the bright one.
    for (const out of [equalized, both]) expect(out[16 * w + 10]).toBeLessThan(out[16 * w + 50]);
    // A clip limit of 1 changes nothing.
    expect(maxDiff(await at({ clipLimit: 1 }), plain)).toBeLessThan(2e-3);
    // The limit bounds how much the noise of a nearly flat image spreads.
    const rand = rng(5);
    const flat = Uint8Array.from({ length: 40 * 40 * 4 }, (_, i) => (i % 4 === 3 ? 255 : 120 + Math.floor(rand() * 3)));
    for (const clipLimit of [2, 16]) {
      const out = await prepare(request(flat, 40, 40, 40, 40, { clipLimit, tileSize: 20 }));
      const spread = Math.max(...out) - Math.min(...out);
      // Capped bins add up to the limit to the slope, the spread excess up to 1.
      expect(spread).toBeLessThanOrEqual((clipLimit + 1) * (2 / 255) * 1.05);
      expect(spread).toBeGreaterThan(2 / 255);
    }
  });

  it("boosts edges by fading flat areas out until only outlines remain", async () => {
    // Flat areas have no edges: they fade to the background, black for a
    // dark image and white for a light one, fully at 0.6 and beyond.
    const flatGrey = solid(30, 20, [90, 90, 90, 255]);
    expect((await prepare(request(flatGrey, 30, 20, 30, 20, { edges: 1, edgeSigma: 2 }))).every((v) => v < 1e-3)).toBe(true);
    const half = await prepare(request(flatGrey, 30, 20, 30, 20, { edges: 0.3, edgeSigma: 2 }));
    expect(half.every((v) => Math.abs(v - (0.5 * 90) / 255) < 2e-3)).toBe(true);
    const flatLight = solid(30, 20, [200, 200, 200, 255]);
    expect((await prepare(request(flatLight, 30, 20, 30, 20, { edges: 1, edgeSigma: 2 }))).every((v) => v > 1 - 1e-3)).toBe(true);
    // A step edge, a third of the way across: an outline along it, however
    // faint the step, in the image's polarity.
    const w = 48;
    const at = w / 3;
    const stepImage = (lo: number, hi: number) => {
      const rgba = new Uint8Array(w * 8 * 4);
      for (let i = 0; i < w * 8; i++) rgba.set(i % w < at ? [lo, lo, lo, 255] : [hi, hi, hi, 255], i * 4);
      return rgba;
    };
    for (const [lo, hi, light] of [
      [0, 255, true],
      [60, 85, false],
    ] as const) {
      const out = await prepare(request(stepImage(lo, hi), w, 8, w, 8, { edges: 1, edgeSigma: 1.5 }));
      const row = out.subarray(4 * w, 5 * w);
      const line = light ? Math.min(row[at - 1], row[at]) : Math.max(row[at - 1], row[at]);
      const background = light ? 1 : 0;
      expect(Math.abs(line - (1 - background))).toBeLessThan(0.05);
      expect(Math.abs(row[2] - background)).toBeLessThan(1e-3);
      expect(Math.abs(row[w - 3] - background)).toBeLessThan(1e-3);
      // Flipped, the image and so the drawing swap polarity.
      const flipped = await prepare(request(stepImage(lo, hi), w, 8, w, 8, { edges: 1, edgeSigma: 1.5, invert: true }));
      expect(maxDiff(flipped, out.map((v) => 1 - v))).toBeLessThan(2e-3);
    }
    // Up to 0.6 nothing is drawn over the image: it only fades into the
    // background away from edges (darker for a dark image, lighter for a
    // light one), keeping its own pixels at edges.
    for (const [lo, hi] of [
      [60, 120],
      [140, 230],
    ]) {
      const plain = await prepare(request(stepImage(lo, hi), w, 8, w, 8));
      const toward = (lo + hi) / 2 > 127.5 ? 1 : -1;
      for (const edges of [0.25, 0.5, 0.6]) {
        const out = await prepare(request(stepImage(lo, hi), w, 8, w, 8, { edges, edgeSigma: 1.5 }));
        expect(out.every((v, i) => (v - plain[i]) * toward > -2e-3)).toBe(true);
        expect(Math.abs(out[4 * w + at] - plain[4 * w + at])).toBeLessThan(0.02);
        const flat = Math.min(1, edges / 0.6);
        const bg = toward > 0 ? 1 : 0;
        expect(out[4 * w + w - 3]).toBeCloseTo(bg + (plain[4 * w + w - 3] - bg) * (1 - flat), 2);
      }
      // Beyond it, what is left turns into lines.
      const late = await prepare(request(stepImage(lo, hi), w, 8, w, 8, { edges: 0.8, edgeSigma: 1.5 }));
      const line = toward > 0 ? 0 : 1;
      expect(Math.abs(late[4 * w + at] - line)).toBeLessThan(Math.abs(plain[4 * w + at] - line));
    }
    // A thin dark line on white stays a dark line on white.
    const line = solid(w, 8, [240, 240, 240, 255]);
    for (let y = 0; y < 8; y++) line.set([20, 20, 20, 255], (y * w + 20) * 4);
    const lined = (await prepare(request(line, w, 8, w, 8, { edges: 1, edgeSigma: 1 }))).subarray(4 * w, 5 * w);
    expect(Math.min(lined[19], lined[20], lined[21])).toBeLessThan(0.1);
    expect(lined[5]).toBeGreaterThan(1 - 1e-3);
    // The noise of a nearly flat image is not an outline.
    for (const base of [120, 200]) {
      const rand = rng(8);
      const noisy = Uint8Array.from({ length: 40 * 40 * 4 }, (_, i) => (i % 4 === 3 ? 255 : base + Math.floor(rand() * 2)));
      const out = await prepare(request(noisy, 40, 40, 40, 40, { edges: 1, edgeSigma: 1 }));
      expect(out.every((v) => (base > 128 ? v > 0.95 : v < 0.05))).toBe(true);
    }
  });

  it("matches the CPU oracle for every combination of preprocessing steps", async () => {
    const shapes: [number, number, number, number][] = [
      [37, 23, 11, 7],
      [9, 5, 20, 13],
      [64, 48, 64, 48],
    ];
    let seed = 1;
    for (const [w, h, ow, oh] of shapes) {
      const rgba = noise(w, h, seed++);
      for (const invert of [false, true]) {
        for (const contrast of [
          { clipLimit: 1, curve: 0 },
          { clipLimit: 1, curve: 0.6, curveSigma: 3 },
          { clipLimit: 6, tileSize: 16, curve: 0 },
          { clipLimit: 12, tileSize: 9, curve: 0.45, curveSigma: 7 },
        ]) {
          for (const [edges, edgeSigma] of [
            [0, 1],
            [1, 1.5],
            [0.6, 9],
          ]) {
            const r = request(rgba, w, h, ow, oh, { invert, ...contrast, edges, edgeSigma });
            expect(maxDiff(await prepare(r), referenceTarget(r)), JSON.stringify(r.preprocessing)).toBeLessThan(5e-4);
          }
        }
      }
    }
  });

  it("splits tall outputs into chunks without changing the result", async () => {
    const r = request(noise(30, 90, 7), 30, 90, 13, 41, { invert: true, clipLimit: 8, tileSize: 20, curve: 0.5, curveSigma: 6, edges: 0.7, edgeSigma: 5 });
    const whole = await prepare(r);
    const chunked = await prepareWith(new TargetPreparer(device!, { chunkBytes: 13 * 4 * 6 }), r);
    expect(maxDiff(whole, chunked)).toBe(0);
    expect(maxDiff(whole, referenceTarget(r))).toBeLessThan(5e-4);
  });

  it("can be cancelled and keeps working afterwards", async () => {
    const r = request(noise(40, 40, 9), 40, 40, 20, 20, { clipLimit: 4, tileSize: 10, curve: 0.5, edges: 1, edgeSigma: 3 });
    const pre = new AbortController();
    pre.abort();
    expect(isAbort(await prepare({ ...r, signal: pre.signal }).catch((e) => e))).toBe(true);
    // Aborting while the GPU works rejects at once.
    const ctrl = new AbortController();
    const running = prepare({ ...r, signal: ctrl.signal });
    ctrl.abort();
    expect(isAbort(await running.catch((e) => e))).toBe(true);
    const tiny = new TargetPreparer(device!, { chunkBytes: 20 * 4 });
    const late = new AbortController();
    const chunked = prepareWith(tiny, { ...r, signal: late.signal });
    await Promise.resolve();
    late.abort();
    expect(isAbort(await chunked.catch((e) => e))).toBe(true);
    expect(maxDiff(await prepare(r), referenceTarget(r))).toBeLessThan(5e-4);
  });

  it("rejects invalid requests", async () => {
    await expect(prepare(request(new Uint8Array(4), 2, 1, 1, 1))).rejects.toThrow(/does not match/);
    await expect(prepare(request(new Uint8Array(4), 1, 1, 0, 1))).rejects.toThrow(/positive/);
    await expect(prepare(request(new Uint8Array(4), 1, 1, 1.5, 1))).rejects.toThrow(/positive/);
    for (const curve of [-1, 1.5, Number.NaN]) {
      await expect(prepare(request(new Uint8Array(4), 1, 1, 1, 1, { curve }))).rejects.toThrow(/curve/);
    }
    for (const clipLimit of [0.5, Infinity, Number.NaN]) {
      await expect(prepare(request(new Uint8Array(4), 1, 1, 1, 1, { clipLimit }))).rejects.toThrow(/clip limit/);
    }
    await expect(prepare(request(new Uint8Array(4), 1, 1, 1, 1, { clipLimit: 2, tileSize: 0 }))).rejects.toThrow(/tile size/);
    // A tile size is only needed when equalizing.
    expect((await prepare(request(solid(1, 1, [255, 255, 255, 255]), 1, 1, 1, 1, { tileSize: 0 })))[0]).toBeCloseTo(1, 3);
    for (const edges of [-1, 1.5, Number.NaN]) {
      await expect(prepare(request(new Uint8Array(4), 1, 1, 1, 1, { edges }))).rejects.toThrow(/edge boost/);
    }
    await expect(prepare(request(new Uint8Array(4), 1, 1, 1, 1, { edges: 1, edgeSigma: 0 }))).rejects.toThrow(/edge boost radius/);
    await expect(prepare(request(new Uint8Array(4), 1, 1, 1, 1, { curve: 0.5, curveSigma: 0 }))).rejects.toThrow(/curve radius/);
    // A radius is only needed when edges are boosted.
    expect((await prepare(request(solid(1, 1, [255, 255, 255, 255]), 1, 1, 1, 1, { edgeSigma: 0 })))[0]).toBeCloseTo(1, 3);
    const limits = { maxStorageBufferBindingSize: 8, maxBufferSize: 1 << 30, maxComputeWorkgroupsPerDimension: 65535 };
    const small = new TargetPreparer(
      new Proxy(device!, {
        get: (d, k) => (k === "limits" ? limits : typeof Reflect.get(d, k) === "function" ? Reflect.get(d, k).bind(d) : Reflect.get(d, k)),
      }),
    );
    await expect(prepareWith(small, request(new Uint8Array(16), 2, 2, 1, 1))).rejects.toThrow(/too large/);
    await expect(
      backend.prepareTarget({ image: { width: 1, height: 1, dispose() {} }, outWidth: 1, outHeight: 1, preprocessing: PLAIN }),
    ).rejects.toThrow(/another backend/);
  });

  it("keeps an uploaded image for many requests and releases it once unused", async () => {
    const r = request(noise(24, 16, 11), 24, 16, 6, 4, { clipLimit: 4, tileSize: 8, curve: 0.4, edges: 0.8, edgeSigma: 2 });
    const image = await backend.uploadImage(r.rgba, r.width, r.height);
    expect([image.width, image.height]).toEqual([24, 16]);
    const at = (preprocessing: Preprocessing) => backend.prepareTarget({ image, outWidth: 6, outHeight: 4, preprocessing });
    // Changing the pixels after the upload changes nothing.
    r.rgba.fill(0);
    const first = await at(r.preprocessing);
    expect(maxDiff(first, referenceTarget({ ...r, rgba: noise(24, 16, 11) }))).toBeLessThan(5e-4);
    expect(maxDiff(await at(PLAIN), first)).toBeGreaterThan(0.01);
    // Released while in use: the running request finishes, later ones fail.
    const running = at(r.preprocessing);
    image.dispose();
    image.dispose();
    expect(maxDiff(await running, first)).toBe(0);
    await expect(at(r.preprocessing)).rejects.toThrow(/released/);
  });
});
