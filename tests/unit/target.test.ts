// Ink target preparation: the WGSL passes on native WebGPU (Dawn) against
// the CPU oracle, and the semantics of every preprocessing step.

import { describe, expect, it } from "vitest";
import { type Preprocessing, type TargetRequest, isAbort } from "../../src/engine/backend";
import { WebGpuWasmBackend } from "../../src/engine/webgpu-wasm/backend";
import { planBlur } from "../../src/engine/webgpu-wasm/plan";
import { TargetPreparer } from "../../src/engine/webgpu-wasm/target";
import { loadCore } from "./helpers/core";
import { requireGpuNotice } from "./helpers/gpu";
import { referenceBlur, referenceTarget, rng } from "./helpers/reference";

const device = await requireGpuNotice();
const PLAIN: Preprocessing = { invert: false, gamma: 1, edgeAmount: 0, edgeSigma: 1 };

function solid(w: number, h: number, px: number[]): Uint8Array {
  return Uint8Array.from({ length: w * h * 4 }, (_, i) => px[i % 4]);
}

function noise(w: number, h: number, seed: number): Uint8Array {
  const rand = rng(seed);
  return Uint8Array.from({ length: w * h * 4 }, () => Math.floor(rand() * 256));
}

/** Left half black, right half white. */
function step(w: number, h: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set(i % w < w / 2 ? [0, 0, 0, 255] : [255, 255, 255, 255], i * 4);
  return rgba;
}

function request(rgba: Uint8Array, w: number, h: number, outW: number, outH: number, pre: Partial<Preprocessing> = {}): TargetRequest {
  return { rgba, width: w, height: h, outWidth: outW, outHeight: outH, preprocessing: { ...PLAIN, ...pre } };
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
  const prepare = (r: TargetRequest) => backend.prepareTarget(r);

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

  it("applies gamma to the grey values, keeping black and white", async () => {
    const greys = new Uint8Array([0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
    const at = async (gamma: number, invert = false) => [...(await prepare(request(greys, 4, 1, 4, 1, { gamma, invert })))];
    const plain = await at(1);
    const half = await at(0.5);
    for (let i = 0; i < 4; i++) expect(half[i]).toBeCloseTo(Math.sqrt(plain[i]), 3);
    expect(half[1]).toBeGreaterThan(plain[1]);
    // Gamma 0 is the limit: everything but black becomes white.
    expect((await at(0)).map((v) => +v.toFixed(3))).toEqual([0, 1, 1, 1]);
    // Gamma acts after the flip.
    const flipped = await at(0.5, true);
    for (const [i, c] of [0, 64, 128, 255].entries()) expect(flipped[i]).toBeCloseTo(Math.sqrt(1 - c / 255), 3);
  });

  it("boosts edges with an unsharp mask that leaves flat areas alone", async () => {
    const flat = await prepare(request(solid(30, 20, [90, 90, 90, 255]), 30, 20, 30, 20, { edgeAmount: 2, edgeSigma: 2 }));
    expect(flat.every((v) => Math.abs(v - 90 / 255) < 2e-3)).toBe(true);
    // A grey step edge: overshoot on both sides near the edge only.
    const w = 40;
    const rgba = new Uint8Array(w * 4 * 4);
    for (let i = 0; i < w * 4; i++) rgba.set(i % w < w / 2 ? [60, 60, 60, 255] : [180, 180, 180, 255], i * 4);
    const plain = await prepare(request(rgba, w, 4, w, 4));
    const boosted = await prepare(request(rgba, w, 4, w, 4, { edgeAmount: 1, edgeSigma: 2 }));
    const row = (a: Float32Array) => a.subarray(w, 2 * w);
    expect(row(boosted)[w / 2 - 1]).toBeLessThan(row(plain)[w / 2 - 1] - 0.03);
    expect(row(boosted)[w / 2]).toBeGreaterThan(row(plain)[w / 2] + 0.03);
    expect(Math.abs(row(boosted)[0] - row(plain)[0])).toBeLessThan(2e-3);
    expect(Math.abs(row(boosted)[w - 1] - row(plain)[w - 1])).toBeLessThan(2e-3);
    // A stronger amount boosts more, and black and white edges stay in range.
    const strong = await prepare(request(rgba, w, 4, w, 4, { edgeAmount: 2, edgeSigma: 2 }));
    expect(row(strong)[w / 2]).toBeGreaterThan(row(boosted)[w / 2]);
    const hard = await prepare(request(step(w, 4), w, 4, w, 4, { edgeAmount: 2, edgeSigma: 3 }));
    expect(hard.every((v) => v >= 0 && v <= 1)).toBe(true);
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
        for (const gamma of [1, 0.35]) {
          for (const [edgeAmount, edgeSigma] of [
            [0, 1],
            [1.3, 1.5],
            [0.8, 9],
          ]) {
            const r = request(rgba, w, h, ow, oh, { invert, gamma, edgeAmount, edgeSigma });
            expect(maxDiff(await prepare(r), referenceTarget(r)), JSON.stringify(r.preprocessing)).toBeLessThan(5e-4);
          }
        }
      }
    }
  });

  it("splits tall outputs into chunks without changing the result", async () => {
    const r = request(noise(30, 90, 7), 30, 90, 13, 41, { invert: true, gamma: 0.6, edgeAmount: 1, edgeSigma: 5 });
    const whole = await prepare(r);
    const chunked = await new TargetPreparer(device!, { chunkBytes: 13 * 4 * 6 }).prepare(r);
    expect(maxDiff(whole, chunked)).toBe(0);
    expect(maxDiff(whole, referenceTarget(r))).toBeLessThan(5e-4);
  });

  it("can be cancelled and keeps working afterwards", async () => {
    const r = request(noise(40, 40, 9), 40, 40, 20, 20, { edgeAmount: 1, edgeSigma: 3 });
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
    const chunked = tiny.prepare({ ...r, signal: late.signal });
    await Promise.resolve();
    late.abort();
    expect(isAbort(await chunked.catch((e) => e))).toBe(true);
    expect(maxDiff(await prepare(r), referenceTarget(r))).toBeLessThan(5e-4);
  });

  it("rejects invalid requests", async () => {
    await expect(prepare(request(new Uint8Array(4), 2, 1, 1, 1))).rejects.toThrow(/does not match/);
    await expect(prepare(request(new Uint8Array(4), 1, 1, 0, 1))).rejects.toThrow(/positive/);
    await expect(prepare(request(new Uint8Array(4), 1, 1, 1.5, 1))).rejects.toThrow(/positive/);
    await expect(prepare(request(new Uint8Array(4), 1, 1, 1, 1, { gamma: -1 }))).rejects.toThrow(/Gamma/);
    await expect(prepare(request(new Uint8Array(4), 1, 1, 1, 1, { gamma: Infinity }))).rejects.toThrow(/Gamma/);
    await expect(prepare(request(new Uint8Array(4), 1, 1, 1, 1, { edgeAmount: -1 }))).rejects.toThrow(/amount/);
    await expect(prepare(request(new Uint8Array(4), 1, 1, 1, 1, { edgeAmount: 1, edgeSigma: 0 }))).rejects.toThrow(/radius/);
    // A radius is only needed when edges are boosted.
    expect((await prepare(request(solid(1, 1, [255, 255, 255, 255]), 1, 1, 1, 1, { edgeSigma: 0 })))[0]).toBeCloseTo(1, 3);
    const limits = { maxStorageBufferBindingSize: 8, maxBufferSize: 1 << 30, maxComputeWorkgroupsPerDimension: 65535 };
    const small = new TargetPreparer(
      new Proxy(device!, {
        get: (d, k) => (k === "limits" ? limits : typeof Reflect.get(d, k) === "function" ? Reflect.get(d, k).bind(d) : Reflect.get(d, k)),
      }),
    );
    await expect(small.prepare(request(new Uint8Array(16), 2, 2, 1, 1))).rejects.toThrow(/too large/);
  });
});
