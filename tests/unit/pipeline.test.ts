// End to end conversion in Node: WASM core, native WebGPU (Dawn) and a fake
// canvas standing in for browser text rendering.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { type FontRef, buildCharset } from "../../src/art/charset";
import { ArtGenerator, type SourceImage } from "../../src/art/generate";
import { toPreprocessing } from "../../src/art/preprocess";
import { fontSegments, verifyCanvas } from "../../src/art/verify";
import { isAbort } from "../../src/engine/backend";
import { WebGpuWasmBackend } from "../../src/engine/webgpu-wasm/backend";
import { loadCore } from "./helpers/core";
import { fakeFonts, fakeOptions, inkFraction, installFakeCanvas, resetFake } from "./helpers/fakeCanvas";
import { requireGpuNotice } from "./helpers/gpu";

installFakeCanvas();
const core = loadCore();
const device = await requireGpuNotice();

function font(id: number, advances: Record<string, number>, isVariable = false): FontRef {
  const entries = Object.entries(advances)
    .map(([ch, em]) => [ch.codePointAt(0)!, em] as const)
    .sort((a, b) => a[0] - b[0]);
  const family = `f${id}`;
  fakeFonts.set(family, { advances: new Map(entries), ascentEm: 0.8, descentEm: 0.2 });
  return {
    id,
    family,
    coverage: Uint32Array.from(entries, (e) => e[0]),
    advanceEm: Float32Array.from(entries, (e) => e[1]),
    isVariable,
    ascentEm: 0.8,
    descentEm: 0.2,
  };
}

/** Left half white, right half black. */
function halves(w: number, h: number): SourceImage {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = x < w / 2 ? 255 : 0;
      rgba.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  return { id: 1, name: "halves", width: w, height: h, limited: false, rgba };
}

/** Black to white from left to right, with a white bar in the dark half. */
function ramp(w: number, h: number): SourceImage {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    const v = x > w * 0.2 && x < w * 0.3 ? 255 : Math.round((x / (w - 1)) * 255);
    rgba.set([v, v, v, 255], i * 4);
  }
  return { id: 2, name: "ramp", width: w, height: h, limited: false, rgba };
}

const PLAIN = { invert: false, contrast: 0, edges: 0 };
const OPTIONS = { widthCells: 12, detail: 6, preprocess: PLAIN };

describe.skipIf(!device)("conversion pipeline", () => {
  const backend = new WebGpuWasmBackend(core, device!);
  let fonts: FontRef[];

  beforeEach(() => {
    resetFake();
    fonts = [
      font(1, { " ": 0.5, "0": 0.5, l: 0.25, M: 0.9, W: 1.0, ".": 0.3 }),
      font(2, { M: 0.6, "#": 0.5, "@": 1.1 }),
    ];
  });

  it("measures the charset by priority", async () => {
    const c = await buildCharset(backend, fonts);
    expect(c.families).toEqual(["f1", "f2"]);
    const at = (ch: string) => c.codepoints.indexOf(ch.codePointAt(0)!);
    expect(c.fontIndex[at("M")]).toBe(0);
    expect(c.advanceEm[at("M")]).toBeCloseTo(0.9);
    expect(c.fontIndex[at("#")]).toBe(1);
    expect(c.chEm).toBe(0.5);
    expect(c.ascentEm).toBeCloseTo(0.8);
    expect(c.perFont).toEqual([6, 2]);
    expect(c.mismatched).toBe(0);
  });

  it("drops characters the browser renders with an unexpected advance", async () => {
    fakeOptions.advanceSkew.set("W".codePointAt(0)!, 0.2);
    const c = await buildCharset(backend, fonts);
    expect(c.mismatched).toBe(1);
    expect([...c.codepoints]).not.toContain("W".codePointAt(0)!);
    // Variable fonts trust the browser.
    fonts[0] = { ...fonts[0], isVariable: true };
    expect((await buildCharset(backend, fonts)).mismatched).toBe(0);
  });

  it("converts an image into rows that respect the width and the image", async () => {
    const gen = new ArtGenerator(backend);
    const stages = new Set<string>();
    const r = await gen.generate(fonts, halves(120, 60), OPTIONS, undefined, (s) => stages.add(s));
    expect([...stages]).toEqual(["charset", "glyphs", "target", "match"]);
    expect(r.rows).toBe(r.lines.length);
    expect(r.text).toBe(r.lines.join("\n"));
    const widthPx = OPTIONS.widthCells * OPTIONS.detail;
    const blank = (cp: number) => cp === 0x20 || inkFraction(cp) === 0;
    for (let row = 0; row < r.rows; row++) {
      // The dark right half only needs blanks, which are trimmed.
      expect(r.layout.rowWidths[row]).toBeLessThanOrEqual(widthPx / 2 + 3 * OPTIONS.detail);
      expect(r.layout.rowWidths[row]).toBeGreaterThan(widthPx / 2 - 1.2 * OPTIONS.detail * 1.1);
      expect(blank(r.lines[row].codePointAt(r.lines[row].length - 1)!)).toBe(false);
      // Bright left half gets denser glyphs than the dark right half.
      const a = r.layout.rowOffsets[row];
      const b = r.layout.rowOffsets[row + 1];
      let left = 0;
      let right = 0;
      for (let i = a; i < b; i++) {
        const cp = r.glyphCodepoint[r.layout.glyphs[i]];
        const ink = ((cp * 7) % 11) / 10;
        if (r.layout.positions[i] < widthPx / 2) left += ink;
        else right += ink;
      }
      expect(left).toBeGreaterThan(right);
    }
    expect(r.stats.cached).toEqual({ charset: false, glyphs: false });
    // Flipped, the rows start with blanks, which are kept, and reach the right edge.
    const flipped = await gen.generate(fonts, halves(120, 60), { ...OPTIONS, preprocess: { ...PLAIN, invert: true } });
    for (let row = 0; row < flipped.rows; row++) {
      expect(blank(flipped.lines[row].codePointAt(0)!)).toBe(true);
      expect(flipped.layout.rowWidths[row]).toBeGreaterThan(widthPx - 1.2 * OPTIONS.detail * 1.1);
    }
    expect(r.stats.characters).toBe(r.layout.glyphs.length);
    expect(r.provided).toEqual([6, 2]);

    // Every preprocessing step changes the output on its own and reuses the glyphs.
    const plain = await gen.generate(fonts, ramp(120, 60), OPTIONS);
    for (const preprocess of [
      { ...PLAIN, invert: true },
      { ...PLAIN, contrast: 0.8 },
      { ...PLAIN, edges: 1 },
      { invert: true, contrast: 0.5, edges: 0.5 },
    ]) {
      const again = await gen.generate(fonts, ramp(120, 60), { ...OPTIONS, preprocess });
      expect(again.stats.cached).toEqual({ charset: true, glyphs: true });
      expect(again.text, JSON.stringify(preprocess)).not.toBe(plain.text);
    }
    const finer = await gen.generate(fonts, halves(120, 60), { ...OPTIONS, detail: 8 });
    expect(finer.stats.cached).toEqual({ charset: true, glyphs: false });
    gen.dispose();
  });

  it("previews the preprocessing without waiting for a conversion, from one upload", async () => {
    const gen = new ArtGenerator(backend);
    const upload = vi.spyOn(backend, "uploadImage");
    const image = ramp(120, 60);
    const options = { widthCells: 12, preprocess: { invert: true, contrast: 0.5, edges: 0.5 } };
    const p = await gen.preview(image, options, 50);
    expect([p.width, p.height]).toEqual([50, 25]);
    // Exactly what a conversion with these options would get, at preview size.
    const handle = await backend.uploadImage(image.rgba, image.width, image.height);
    const direct = await backend.prepareTarget({
      image: handle,
      outWidth: 50,
      outHeight: 25,
      preprocessing: toPreprocessing(options.preprocess, 120, 12),
    });
    handle.dispose();
    expect([...p.grey]).toEqual([...direct]);
    expect((await gen.preview(image, options, 1000)).width).toBe(120);
    // A conversion blocked in matching does not hold previews back.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const layout = backend.layout.bind(backend);
    const spy = vi.spyOn(backend, "layout").mockImplementation(async (req) => {
      await gate;
      return layout(req);
    });
    const converting = gen.generate(fonts, image, { ...OPTIONS, preprocess: options.preprocess });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    const during = await gen.preview(image, { ...options, preprocess: PLAIN }, 50);
    expect(during.grey.length).toBe(50 * 25);
    release();
    await converting;
    spy.mockRestore();
    // The preview, the conversion and the direct check: two uploads in total.
    expect(upload).toHaveBeenCalledTimes(2);
    upload.mockRestore();
    const pre = new AbortController();
    pre.abort();
    await expect(gen.preview(image, options, 50, pre.signal)).rejects.toThrow();
    gen.dispose();
  });

  it("verifies native rendering and detects a browser that resolves fonts differently", async () => {
    const gen = new ArtGenerator(backend);
    // Flipped, rows start with blanks of the first font and end with glyphs of the second.
    const r = await gen.generate(fonts, halves(90, 60), { ...OPTIONS, preprocess: { ...PLAIN, invert: true } });
    expect(new Set(fontSegments(r, 0).map((s) => s.font))).toEqual(new Set([0, 1]));
    const ok = await verifyCanvas(r, backend);
    expect(ok.pass).toBe(true);
    expect(ok.maxAdvanceError).toBeLessThan(1e-6);
    expect(ok.advanceRows).toBe(0);
    // Characters whose advance changes in a run (as clustering would) are
    // caught even though both drawings use runs of the same font.
    const inner = [...r.lines[0]][1].codePointAt(0)!;
    fakeOptions.inRunSkew.set(inner, 0.5);
    const clustered = await verifyCanvas(r, backend);
    expect(clustered.pass).toBe(false);
    expect(clustered.advanceRows).toBeGreaterThan(0);
    expect(clustered.maxAdvanceError).toBeGreaterThan(1);
    fakeOptions.inRunSkew.clear();
    expect(ok.similarity).toBeGreaterThan(0.99);
    expect(ok.badRows).toBe(0);
    // A browser that picks the second font for everything it has, which now
    // has every character, drawn differently.
    const second = fakeFonts.get("f2")!;
    for (const [cp, em] of fakeFonts.get("f1")!.advances) second.advances.set(cp, em);
    second.ink = () => 1;
    fakeOptions.reverseFallback = true;
    const bad = await verifyCanvas(r, backend);
    expect(bad.pass).toBe(false);
    expect(bad.badRows).toBeGreaterThan(0);
    expect(bad.worstRowSimilarity).toBeLessThan(0.9);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(verifyCanvas({ ...r, rows: 64, lines: Array(64).fill(""), layout: { ...r.layout, rowOffsets: new Uint32Array(65) } }, backend, ctrl.signal)).rejects.toThrow();
    gen.dispose();
  });

  it("reports unusable inputs", async () => {
    const gen = new ArtGenerator(backend);
    await expect(gen.generate([], halves(10, 10), OPTIONS)).rejects.toThrow(/at least one font/);
    const empty: FontRef = { ...fonts[0], id: 9, coverage: new Uint32Array(), advanceEm: new Float32Array() };
    await expect(gen.generate([empty], halves(10, 10), OPTIONS)).rejects.toThrow(/no usable characters/);
    const narrow = font(5, { "0": 0.5, i: 0.01 });
    await expect(gen.generate([font(6, { i: 0.001 }), narrow].slice(0, 1), halves(10, 10), OPTIONS)).rejects.toThrow(/usable width/);
    gen.dispose();
  });

  it("can be cancelled, and a cancelled run never blocks the next one", async () => {
    const gen = new ArtGenerator(backend);
    const pre = new AbortController();
    pre.abort();
    expect(isAbort(await gen.generate(fonts, halves(40, 40), OPTIONS, pre.signal).catch((e) => e))).toBe(true);
    const ctrl = new AbortController();
    const first = gen.generate(fonts, halves(40, 40), OPTIONS, ctrl.signal, (stage) => stage === "glyphs" && ctrl.abort());
    const second = gen.generate(fonts, halves(40, 40), OPTIONS);
    expect(isAbort(await first.catch((e) => e))).toBe(true);
    const r = await second;
    expect(r.lines.length).toBeGreaterThan(0);
    // Cancelling during matching.
    const late = new AbortController();
    const err = await gen
      .generate(fonts, halves(40, 40), { ...OPTIONS, widthCells: 30 }, late.signal, (s) => s === "match" && late.abort())
      .catch((e) => e);
    expect(isAbort(err)).toBe(true);
    gen.dispose();
  });
});
