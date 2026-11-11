// The compiled WASM core through its JS bindings and the backend wrapper.

import { describe, expect, it } from "vitest";
import { WebGpuWasmBackend } from "../../src/engine/webgpu-wasm/backend";
import { fixture, loadCore, repoFile } from "./helpers/core";

const core = loadCore();

/** A device stand-in for the CPU-only backend methods. */
const stubDevice = {
  limits: {},
  lost: new Promise(() => {}),
  createBindGroupLayout: () => ({}),
  destroy() {},
} as unknown as GPUDevice;

const backend = new WebGpuWasmBackend(core, stubDevice);

describe("font parsing", () => {
  it("parses every container format to the same coverage", async () => {
    const ttf = await backend.parseFont(fixture("sans.ttf"));
    expect(ttf).toMatchObject({ format: "ttf", family: "Fixture Sans", unitsPerEm: 2048, isVariable: false, colorGlyphs: 0 });
    expect(ttf.standalone).toBeNull();
    for (const name of ["sans.woff", "sans.woff2"]) {
      const f = await backend.parseFont(fixture(name));
      expect([...f.codepoints]).toEqual([...ttf.codepoints]);
      expect([...f.advances]).toEqual([...ttf.advances]);
    }
    expect([...ttf.codepoints]).not.toContain(0x0301);
    expect([...ttf.codepoints]).not.toContain(0x05d0);
  });

  it("extracts the first face of collections for the browser", async () => {
    const ttc = await backend.parseFont(fixture("collection.ttc"));
    expect(ttc.format).toBe("ttc");
    expect(ttc.standalone).not.toBeNull();
    const again = await backend.parseFont(ttc.standalone!);
    expect(again.format).toBe("ttf");
    expect(again.family).toBe("Fixture Mono");
    expect([...again.codepoints]).toEqual([...ttc.codepoints]);
  });

  it("handles shaping heavy, color and variable fonts", async () => {
    const arabic = await backend.parseFont(fixture("arabic.ttf"));
    expect([...arabic.codepoints].filter((c) => c >= 0x600 && c <= 0x6ff)).toEqual([]);
    expect([...arabic.codepoints]).toContain(0x41);
    const color = await backend.parseFont(fixture("color.ttf"));
    expect(color.colorGlyphs).toBe(2);
    expect([...color.codepoints]).toEqual([0x20]);
    expect((await backend.parseFont(fixture("variable.ttf"))).isVariable).toBe(true);
    expect([...(await backend.parseFont(fixture("features.ttf"))).codepoints]).toContain(0xfb01);
  });

  it("turns invalid input into errors instead of crashes", async () => {
    await expect(backend.parseFont(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not a TTF/);
    await expect(backend.parseFont(fixture("sans.woff2").slice(0, 100))).rejects.toThrow(/decode/);
    await expect(backend.parseFont(fixture("sans.ttf").slice(0, 20))).rejects.toThrow(/parse/);
    // The module keeps working after errors.
    expect((await backend.parseFont(fixture("mono.ttf"))).family).toBe("Fixture Mono");
  });
});

describe("charset", () => {
  it("merges coverage by priority", async () => {
    const m = await backend.mergeCoverage([Uint32Array.from([2, 3]), Uint32Array.from([1, 2, 4]), new Uint32Array()]);
    expect([...m.codepoints]).toEqual([1, 2, 3, 4]);
    expect([...m.fontIndex]).toEqual([1, 0, 0, 1]);
    expect(() => core.mergeCoverage(Uint32Array.from([1]), Uint32Array.from([2]))).toThrow(/add up/);
  });

  it("exposes the exclusion rules, all documented in the README", async () => {
    const rules = await backend.exclusionRules();
    expect(rules.length).toBeGreaterThan(40);
    expect(rules.every((r) => ["range", "category", "bidi"].includes(r.kind) && r.key && r.description)).toBe(true);
    const readme = repoFile("README.md");
    for (const r of rules) expect(readme).toContain(`\`${r.key}\``);
    expect(core.isUsable(0x41)).toBe(true);
    expect(core.isUsable(0x627)).toBe(false);
  });
});

describe("image preparation", () => {
  it("composites over white, converts to grey and resamples", async () => {
    const rgba = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
    const t = await backend.prepareTarget({ rgba, width: 2, height: 2, outWidth: 2, outHeight: 2, invert: false });
    expect([...t].map((v) => +v.toFixed(3))).toEqual([1, 0, 1, 0]);
    const inv = await backend.prepareTarget({ rgba: new Uint8ClampedArray(rgba), width: 2, height: 2, outWidth: 1, outHeight: 1, invert: true });
    expect(inv[0]).toBeCloseTo(1 - 0.7354, 3);
  });

  it("rejects inconsistent dimensions", async () => {
    await expect(backend.prepareTarget({ rgba: new Uint8Array(4), width: 2, height: 1, outWidth: 1, outHeight: 1, invert: false })).rejects.toThrow(/does not match/);
    await expect(backend.prepareTarget({ rgba: new Uint8Array(4), width: 1, height: 1, outWidth: 0, outHeight: 1, invert: false })).rejects.toThrow(/positive/);
  });
});

describe("glyph bank and layout bindings", () => {
  it("builds banks and validates cells", () => {
    expect(() => new core.GlyphBankBuilder(0)).toThrow(/positive/);
    const b = new core.GlyphBankBuilder(2);
    const page = new Uint8Array(4 * 2 * 4).fill(255);
    expect(() => b.addPage(page, 4, Uint32Array.from([3]), Uint32Array.from([0]), Uint32Array.from([0]), Uint32Array.from([2]))).toThrow(/outside/);
    expect(() => b.addPage(page, 4, Uint32Array.from([0]), Uint32Array.from([1]), Uint32Array.from([0]), Uint32Array.from([2]))).toThrow(/outside/);
    expect(() => b.addPage(page, 4, Uint32Array.from([0]), Uint32Array.from([0]), Uint32Array.from([0]), Uint32Array.from([0]))).toThrow(/outside/);
    expect(() => b.addPage(page, 3, Uint32Array.from([0]), Uint32Array.from([0]), Uint32Array.from([0]), Uint32Array.from([1]))).toThrow(/page width/);
    expect(() => b.addPage(page, 4, Uint32Array.from([0, 1]), Uint32Array.from([0]), Uint32Array.from([0]), Uint32Array.from([1]))).toThrow(/length/);
    b.addPage(page, 4, Uint32Array.from([0, 2]), Uint32Array.from([0, 0]), Uint32Array.from([0, 1]), Uint32Array.from([2, 2]));
    const bank = b.build();
    expect(bank.binCount).toBe(1);
    expect(bank.duplicates).toBe(1);
    expect([...bank.bins()]).toEqual([2, 0, 1, 0]);
    expect(bank.maxWidth).toBe(2);
    expect(bank.cellH).toBe(2);
    expect(bank.maxGroupCount).toBe(1);
    expect([...bank.slotGlyph()]).toEqual([0, 0xffffffff, 0xffffffff, 0xffffffff]);
    expect(bank.data()[0]).toBe(255);
    expect(bank.norms()[0]).toBeCloseTo(4);
    bank.free();
  });

  it("solves layouts and validates the inputs", () => {
    // One row, width 2, one bin; glyph 0 (advance 1) is perfect everywhere.
    const costs = Float32Array.from([0, 0]);
    const slots = Uint32Array.from([0, 0]);
    const layout = core.solveLayout(1, 2, 1, 1, costs, slots, Uint32Array.from([0]), Float32Array.from([1]), Float32Array.from([1, 1]));
    expect([...layout.glyphs()]).toEqual([0, 0]);
    expect([...layout.positions()]).toEqual([0, 1]);
    expect([...layout.rowOffsets()]).toEqual([0, 2]);
    expect([...layout.rowWidths()]).toEqual([2]);
    expect(layout.totalCost).toBe(0);
    layout.free();
    const sg = Uint32Array.from([0]);
    const adv = Float32Array.from([1]);
    expect(() => core.solveLayout(1, 2, 1, 1, costs.slice(0, 1), slots, sg, adv, Float32Array.from([1, 1]))).toThrow(/cost/);
    expect(() => core.solveLayout(1, 2, 1, 1, costs, slots, sg, adv, Float32Array.from([1]))).toThrow(/target/);
    expect(() => core.solveLayout(1, 2, 1, 1, costs, Uint32Array.from([5, 0]), sg, adv, Float32Array.from([1, 1]))).toThrow(/slot/);
    expect(() => core.solveLayout(1, 2, 1, 1, costs, slots, Uint32Array.from([9]), adv, Float32Array.from([1, 1]))).toThrow(/glyph/);
  });

  it("compares images", async () => {
    const a = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 255]);
    expect((await backend.compareImages(a, a, 2, 0.1, 0)).similarity).toBe(1);
    const c = await backend.compareImages(a, new Uint8ClampedArray(8), 2, 0.1, 1);
    expect(c.similarity).toBe(0);
    expect(c.pixels).toBe(2);
    await expect(backend.compareImages(a, new Uint8Array(4), 1, 0, 0)).rejects.toThrow(/size/);
    await expect(backend.compareImages(a, a, 3, 0, 0)).rejects.toThrow(/width/);
  });

  it("rejects banks of other backends", async () => {
    await expect(
      backend.layout({ bank: { cellH: 1 } as never, target: new Float32Array(), rows: 0, width: 0, advances: new Float32Array() }),
    ).rejects.toThrow(/another backend/);
  });
});
