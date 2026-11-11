// Runs the real WGSL matcher on a native WebGPU implementation (Dawn) and
// compares it with the CPU oracle. Skipped when no adapter is available.

import { describe, expect, it } from "vitest";
import { isAbort } from "../../src/engine/backend";
import { WebGpuWasmBackend } from "../../src/engine/webgpu-wasm/backend";
import { GpuBank, Matcher, abortable } from "../../src/engine/webgpu-wasm/matcher";
import { loadCore } from "./helpers/core";
import { requireGpuNotice } from "./helpers/gpu";
import { INVALID, type Problem, randomProblem, referenceScores } from "./helpers/reference";

const core = loadCore();
const device = await requireGpuNotice();

async function scoreAll(matcher: Matcher, p: Problem, signal?: AbortSignal, onProgress?: (f: number) => void) {
  const bank = new GpuBank(device!, p.packed);
  const nb = p.packed.binCount;
  const costs = new Float32Array(p.rows * p.width * nb);
  const slots = new Uint32Array(p.rows * p.width * nb);
  const batches: number[] = [];
  try {
    for await (const b of matcher.score(bank, p.target, p.rows, p.width, signal, onProgress)) {
      costs.set(b.costs, b.rowStart * p.width * nb);
      slots.set(b.slots, b.rowStart * p.width * nb);
      batches.push(b.rowCount);
    }
  } finally {
    bank.dispose();
  }
  return { costs, slots, batches };
}

function expectMatchesReference(p: Problem, got: { costs: Float32Array; slots: Uint32Array }) {
  const ref = referenceScores(p);
  let compared = 0;
  for (let i = 0; i < ref.costs.length; i++) {
    if (ref.costs[i] >= INVALID) {
      expect(got.costs[i]).toBeGreaterThanOrEqual(1e29);
      continue;
    }
    expect(Math.abs(got.costs[i] - ref.costs[i])).toBeLessThan(1e-3 * Math.max(1, ref.costs[i]));
    if (got.slots[i] !== ref.slots[i]) {
      // Only acceptable for numerically tied candidates.
      const slot = got.slots[i];
      expect(slot).not.toBe(0xffffffff);
    } else compared++;
  }
  expect(compared).toBeGreaterThan(ref.costs.length * 0.5);
}

describe.skipIf(!device)("WebGPU matcher", () => {
  it("matches the CPU oracle", async () => {
    const p = randomProblem(core, { seed: 1, widths: [3, 5, 5, 2, 3, 7, 5, 1, 3], cellH: 6, rows: 3, width: 37 });
    const got = await scoreAll(new Matcher(device!), p);
    expectMatchesReference(p, got);
    expect(got.batches).toEqual([3]);
  });

  it("handles many groups split over dispatches and rows split over batches", async () => {
    const widths = Array.from({ length: 300 }, (_, i) => 1 + (i % 4));
    const p = randomProblem(core, { seed: 2, widths, cellH: 4, rows: 5, width: 300 });
    // Force several group chunks per row range and two rows per batch.
    const perRowGroup = p.width * 4 * p.packed.maxWidth * p.packed.cellH * p.packed.binCount;
    const matcher = new Matcher(device!, { dispatchBudget: perRowGroup * 32, batchBytes: 2 * p.width * Math.max(p.packed.cellH, p.packed.binCount) * 4 });
    const progress: number[] = [];
    const got = await scoreAll(matcher, p, undefined, (f) => progress.push(f));
    expectMatchesReference(p, got);
    expect(got.batches).toEqual([2, 2, 1]);
    expect(progress.at(-1)).toBeCloseTo(1);
    expect(progress.every((v, i) => i === 0 || v >= progress[i - 1])).toBe(true);
  });

  it("is cancelled promptly", async () => {
    const widths = Array.from({ length: 200 }, (_, i) => 2 + (i % 3));
    const p = randomProblem(core, { seed: 3, widths, cellH: 8, rows: 8, width: 200 });
    const perRowGroup = p.width * 4 * p.packed.maxWidth * p.packed.cellH * p.packed.binCount;
    const matcher = new Matcher(device!, { dispatchBudget: perRowGroup * 32 });
    const ctrl = new AbortController();
    const err = await scoreAll(matcher, p, ctrl.signal, () => ctrl.abort()).catch((e) => e);
    expect(isAbort(err)).toBe(true);
    const pre = new AbortController();
    pre.abort();
    await expect(abortable(new Promise(() => {}), pre.signal)).rejects.toThrow();
    await expect(abortable(Promise.reject(new Error("x")), new AbortController().signal)).rejects.toThrow("x");
    expect(await abortable(Promise.resolve(5))).toBe(5);
  });

  it("produces the same layout as solving the oracle scores", async () => {
    const p = randomProblem(core, { seed: 4, widths: [2, 3, 3, 4, 5, 2, 6], cellH: 5, rows: 4, width: 41 });
    const ref = referenceScores(p);
    const expected = core.solveLayout(p.rows, p.width, p.packed.binCount, p.packed.cellH, ref.costs, ref.slots, p.packed.slotGlyph, p.advances, p.target);
    const gpu = await scoreAll(new Matcher(device!), p);
    const actual = core.solveLayout(p.rows, p.width, p.packed.binCount, p.packed.cellH, gpu.costs, gpu.slots, p.packed.slotGlyph, p.advances, p.target);
    expect(actual.totalCost).toBeCloseTo(expected.totalCost, 2);
    expect([...actual.rowWidths()].every((w) => w <= p.width + 1e-4)).toBe(true);
    expected.free();
    actual.free();
  });

  it("runs the full backend: bank building, scoring and solving", async () => {
    const backend = new WebGpuWasmBackend(core, device!);
    const cellH = 4;
    // Two glyphs: blank and full, both 2 px wide.
    const page = new Uint8Array(4 * cellH * 4);
    for (let y = 0; y < cellH; y++) for (let x = 2; x < 4; x++) page[(y * 4 + x) * 4] = 255;
    const builder = await backend.createGlyphBankBuilder(cellH);
    await builder.addPage({
      rgba: page,
      width: 4,
      xs: Uint32Array.from([0, 2]),
      ys: Uint32Array.from([0, 0]),
      glyphs: Uint32Array.from([0, 1]),
      widths: Uint32Array.from([2, 2]),
    });
    const bank = await builder.build();
    await expect(builder.build()).rejects.toThrow(/already/);
    expect(bank).toMatchObject({ cellH, binCount: 1, maxWidth: 2, glyphCount: 2, duplicates: 0 });
    // Target: dark, bright, bright, dark in 2 px steps.
    const width = 8;
    const target = new Float32Array(cellH * width);
    for (let y = 0; y < cellH; y++) for (let x = 2; x < 6; x++) target[y * width + x] = 1;
    const r = await backend.layout({ bank, target, rows: 1, width, advances: Float32Array.from([2, 2]) });
    expect([...r.glyphs]).toEqual([0, 1, 1, 0]);
    expect([...r.positions]).toEqual([0, 2, 4, 6]);
    expect(r.totalCost).toBeCloseTo(0, 4);
    expect(r.ms.score).toBeGreaterThanOrEqual(0);
    bank.dispose();
    const empty = await backend.createGlyphBankBuilder(2);
    await expect(empty.build()).rejects.toThrow(/No usable glyphs/);
  });
});
