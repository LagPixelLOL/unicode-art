import { describe, expect, it } from "vitest";
import { cssFont, planAtlas } from "../../src/art/atlas";
import { advanceAgrees, charsetKey, fontAdvance } from "../../src/art/charset";
import type { ArtResult } from "../../src/art/generate";
import { DEFAULT_CH_EM, MAX_GLYPH_CELLS, computeGeometry, rowCount, selectGlyphs } from "../../src/art/geometry";
import { baselineTolerance, domTolerance, evaluateDom, fontSegments } from "../../src/art/verify";
import { AbortedError, type BackendFactory, isAbort, throwIfAborted } from "../../src/engine/backend";
import { selectBackend } from "../../src/engine/registry";
import { concatLayouts } from "../../src/engine/webgpu-wasm/backend";
import {
  COLUMNS_PER_INVOCATION,
  type DeviceLimits,
  MIN_GROUPS_PER_DISPATCH,
  SubmissionSizer,
  chooseWorkgroup,
  planBatches,
  planDispatches,
  specializeShader,
  workgroupBytes,
} from "../../src/engine/webgpu-wasm/plan";
import { classifyFile, imageFromItems, limitSize } from "../../src/image/load";
import { dropIndex } from "../../src/ui/FontList";
import { placePanel } from "../../src/ui/HoverPanel";
import { errorText } from "../../src/ui/notices";
import { readOptions } from "../../src/ui/options";
import { contentSizeEm, fitFontSize, splitFontSize } from "../../src/ui/OutputBox";
import { asciiOnly, escapeMarkdown, plural, summarizeExclusions } from "../../src/ui/text";
import { formatMs, timingRows } from "../../src/ui/Timing";
import { repoFile } from "./helpers/core";

const LIMITS: DeviceLimits = {
  maxComputeWorkgroupStorageSize: 16384,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupsPerDimension: 65535,
  maxStorageBufferBindingSize: 128 << 20,
  maxBufferSize: 256 << 20,
};

describe("geometry", () => {
  const geo = computeGeometry({ chEm: 0.5, ascentEm: 0.9, descentEm: 0.25, detail: 10, widthCells: 80 });

  it("sizes the font so a cell is `detail` samples wide", () => {
    expect(geo.fontPx).toBe(20);
    expect(geo.widthPx).toBe(800);
    expect(geo.cellH).toBe(23);
    expect(geo.lineHeightEm).toBeCloseTo(23 / 20);
    // Half leading: (23 - 22.999...) / 2 above the ascent.
    expect(geo.baselinePx).toBeCloseTo(0.5 * (23 - 23) + 18, 5);
  });

  it("uses font sizes browsers can shape exactly", () => {
    const g = computeGeometry({ chEm: 0.5718, ascentEm: 1, descentEm: 0.3, detail: 10, widthCells: 80 });
    expect(g.fontPx * 64).toBe(Math.round(g.fontPx * 64));
    expect(Math.abs(g.fontPx * 0.5718 - 10)).toBeLessThan(0.01);
    expect(splitFontSize(7.3)).toEqual({ layout: 128, scale: 7.3 / 128 });
    expect(splitFontSize(128)).toEqual({ layout: 128, scale: 1 });
    expect(splitFontSize(200.3)).toEqual({ layout: 12819 / 64, scale: 200.3 / (12819 / 64) });
    expect(splitFontSize(0)).toEqual({ layout: 0, scale: 1 });
  });

  it("centres the content area in rounded rows", () => {
    const g = computeGeometry({ chEm: 0.6, ascentEm: 1.0, descentEm: 0.3, detail: 7, widthCells: 3 });
    const content = 1.3 * g.fontPx;
    expect(g.baselinePx).toBeCloseTo((g.cellH - content) / 2 + g.fontPx);
    expect(() => computeGeometry({ chEm: 0, ascentEm: 1, descentEm: 0, detail: 10, widthCells: 1 })).toThrow();
    expect(() => computeGeometry({ chEm: 0.5, ascentEm: 1, descentEm: 0, detail: 0, widthCells: 1 })).toThrow();
    expect(DEFAULT_CH_EM).toBe(0.5);
  });

  it("keeps the image aspect ratio in rows", () => {
    expect(rowCount(800, 230, geo)).toBe(10);
    expect(rowCount(800, 1, geo)).toBe(1);
    expect(rowCount(100, 1000, geo)).toBe(348);
  });

  it("drops glyphs that would not move the pen or are too wide", () => {
    const sel = selectGlyphs([0.5, 0.01, 0.25, 2, 1.49, 1.51], geo, [true, true, true, true, true, false]);
    expect([...sel.charsetIndex]).toEqual([0, 2, 4]);
    expect([...sel.widths]).toEqual([10, 5, 30]);
    expect(sel.advancePx[2]).toBeCloseTo(29.8);
    expect(sel.tooNarrow).toBe(1);
    expect(sel.tooWide).toBe(1);
    expect(MAX_GLYPH_CELLS * geo.detail).toBe(30);
    expect(selectGlyphs([Number.NaN], geo).tooNarrow).toBe(1);
  });
});

describe("atlas", () => {
  it("shelf packs cells with margins across pages", () => {
    const plan = planAtlas([3, 3, 3, 3, 3], 2, 1, 10);
    expect(plan.pageW).toBe(10);
    expect(plan.slots).toEqual([
      { page: 0, x: 1, y: 1 },
      { page: 0, x: 6, y: 1 },
      { page: 0, x: 1, y: 5 },
      { page: 0, x: 6, y: 5 },
      { page: 1, x: 1, y: 1 },
    ]);
    expect(plan.pages).toBe(2);
    expect(planAtlas([], 4, 2).pages).toBe(0);
    // Pages grow to fit a single huge cell.
    const big = planAtlas([5000], 3000, 2, 2048);
    expect(big.pageW).toBe(5004);
    expect(big.pageH).toBe(3004);
  });

  it("quotes font families", () => {
    expect(cssFont(12.5, "uaf-1")).toBe('12.5px "uaf-1"');
    expect(cssFont(10, ["a", "b"])).toBe('10px "a", "b"');
  });
});

describe("matcher planning", () => {
  it("specializes the shader constants", () => {
    const src = repoFile("src/engine/webgpu-wasm/matcher.wgsl");
    const out = specializeShader(src, { WG: 32, CELL_H: 21, MAX_W: 33 });
    expect(out).toContain("const WG: u32 = 32u; // param");
    expect(out).toContain("const CELL_H: u32 = 21u; // param");
    expect(out).toContain("const MAX_W: u32 = 33u; // param");
    expect(() => specializeShader(src, { WG: 0, CELL_H: 1, MAX_W: 1 })).toThrow(/Invalid/);
    expect(() => specializeShader("nothing", { WG: 1, CELL_H: 1, MAX_W: 1 })).toThrow(/not found/);
  });

  it("chooses a workgroup that fits shared memory and the row", () => {
    expect(workgroupBytes(64, 20, 30)).toBe((64 * COLUMNS_PER_INVOCATION + 29) * 20 * 4);
    expect(chooseWorkgroup(10, 20, LIMITS)).toEqual({ size: 64, tile: 256 });
    // 64 * 4 columns do not fit in 16 KiB with tall cells.
    expect(chooseWorkgroup(20, 30, LIMITS)?.size).toBe(32);
    // Narrow rows prefer smaller workgroups, but not below 32.
    expect(chooseWorkgroup(10, 20, LIMITS, 200)?.size).toBe(32);
    expect(chooseWorkgroup(10, 20, LIMITS, 20)?.size).toBe(32);
    expect(chooseWorkgroup(2000, 100, LIMITS)).toBeNull();
    expect(chooseWorkgroup(30, 30, { ...LIMITS, maxComputeWorkgroupStorageSize: 4096 })?.size).toBe(1);
    expect(chooseWorkgroup(10, 20, { ...LIMITS, maxComputeInvocationsPerWorkgroup: 16 })?.size).toBe(16);
  });

  it("splits rows into buffer sized batches", () => {
    expect(planBatches(10, 100, 10, 4, LIMITS)).toEqual([{ rowStart: 0, rowCount: 10 }]);
    const small = { ...LIMITS, maxStorageBufferBindingSize: 100 * 10 * 4 * 3 };
    expect(planBatches(7, 100, 10, 4, small)).toEqual([
      { rowStart: 0, rowCount: 3 },
      { rowStart: 3, rowCount: 3 },
      { rowStart: 6, rowCount: 1 },
    ]);
    expect(() => planBatches(1, 100, 10, 4, { ...LIMITS, maxBufferSize: 10 })).toThrow(/too wide/);
    expect(planBatches(0, 10, 1, 1, LIMITS)).toEqual([]);
  });

  it("splits work into bounded dispatches that cover every row and group once", () => {
    const rows = 5;
    const groups = 100;
    const d = planDispatches(rows, 50, 10, 8, 3, groups, 50 * 4 * 8 * 10 * 3 * 40);
    const covered = new Map<string, number>();
    for (const x of d) {
      expect(x.groupEnd - x.groupStart).toBeLessThanOrEqual(Math.max(40, MIN_GROUPS_PER_DISPATCH));
      expect(x.first).toBe(x.groupStart === 0);
      for (let r = x.rowStart; r < x.rowStart + x.rowCount; r++) {
        for (let g = x.groupStart; g < x.groupEnd; g++) covered.set(`${r}/${g}`, (covered.get(`${r}/${g}`) ?? 0) + 1);
      }
    }
    expect(covered.size).toBe(rows * groups);
    expect([...covered.values()].every((v) => v === 1)).toBe(true);
    // Results of a row range must be initialized before later chunks update them.
    const firstIndex = d.findIndex((x) => x.rowStart === 0 && x.first);
    expect(d.findIndex((x) => x.rowStart === 0 && !x.first)).toBeGreaterThan(firstIndex);
    // Tiny problems become a single dispatch; an empty bank still initializes.
    expect(planDispatches(2, 10, 2, 2, 1, 3)).toHaveLength(1);
    expect(planDispatches(1, 10, 2, 2, 1, 0)[0]).toMatchObject({ groupStart: 0, groupEnd: 1, first: true });
  });

  it("sizes submissions towards the target time", () => {
    const s = new SubmissionSizer(30, 64);
    expect(s.next()).toBe(1);
    s.record(1, 1); // fast: grows, but at most doubling
    expect(s.next()).toBe(2);
    s.record(2, 2);
    expect(s.next()).toBe(4);
    s.record(4, 240); // 60 ms per dispatch: shrink at once
    expect(s.next()).toBe(1);
    for (let i = 0; i < 20; i++) s.record(s.next(), 0);
    expect(s.next()).toBe(64);
    s.record(0, 5);
    expect(s.next()).toBe(64);
  });
});

describe("charset helpers", () => {
  const font = { coverage: Uint32Array.from([0x20, 0x41, 0x42, 0x1f600]), advanceEm: Float32Array.from([0.25, 0.6, 0.65, 1]) };

  it("finds advances", () => {
    expect(fontAdvance(font, 0x41)).toBeCloseTo(0.6);
    expect(fontAdvance(font, 0x1f600)).toBe(1);
    expect(fontAdvance(font, 0x43)).toBeNull();
    expect(fontAdvance({ coverage: new Uint32Array(), advanceEm: new Float32Array() }, 1)).toBeNull();
  });

  it("checks that the browser renders with the expected font", () => {
    expect(advanceAgrees(0.6, 0.6, false)).toBe(true);
    expect(advanceAgrees(0.605, 0.6, false)).toBe(true);
    expect(advanceAgrees(0.62, 0.6, false)).toBe(false);
    expect(advanceAgrees(0.62, 0.6, true)).toBe(true);
    expect(advanceAgrees(0.0625, Number.NaN, false)).toBe(true);
    expect(advanceAgrees(0, 0, true)).toBe(false);
    expect(advanceAgrees(Number.NaN, 0.5, true)).toBe(false);
    expect(charsetKey([{ id: 3 }, { id: 1 }] as never)).toBe("3,1");
  });
});

function fakeResult(): ArtResult {
  return {
    lines: ["ab", "", "c"],
    text: "ab\n\nc",
    families: ["f"],
    provided: [3],
    geometry: computeGeometry({ chEm: 0.5, ascentEm: 0.8, descentEm: 0.2, detail: 10, widthCells: 2 }),
    rows: 3,
    layout: {
      glyphs: Uint32Array.from([0, 1, 2]),
      positions: Float32Array.from([0, 10, 0]),
      rowOffsets: Uint32Array.from([0, 2, 2, 3]),
      rowWidths: Float32Array.from([18, 0, 9]),
      totalCost: 4,
      ms: { score: 10, solve: 2 },
    },
    glyphCodepoint: Uint32Array.from([0x61, 0x62, 0x63]),
    glyphFont: Uint32Array.from([0, 0, 0]),
    glyphAdvancePx: Float32Array.from([10, 8, 9]),
    stats: {
      candidates: 3,
      duplicates: 0,
      distinct: 3,
      characters: 3,
      rmsError: 0.1,
      excluded: { mismatched: 0, tooNarrow: 0, tooWide: 0 },
      ms: { charset: 5, glyphs: 0, target: 3, match: 13 },
      cached: { charset: false, glyphs: true },
    },
  };
}

describe("canvas verification", () => {
  it("groups each row into runs of the same font", () => {
    const r = fakeResult();
    r.glyphFont = Uint32Array.from([0, 1, 0]);
    r.layout.glyphs = Uint32Array.from([0, 0, 1, 2, 2, 0]);
    r.layout.rowOffsets = Uint32Array.from([0, 5, 5, 6]);
    r.glyphCodepoint = Uint32Array.from([0x61, 0x1f600, 0x63]);
    expect(fontSegments(r, 0)).toEqual([
      { font: 0, text: "aa" },
      { font: 1, text: "\u{1f600}" },
      { font: 0, text: "cc" },
    ]);
    expect(fontSegments(r, 1)).toEqual([]);
    expect(fontSegments(r, 2)).toEqual([{ font: 0, text: "a" }]);
  });
});

describe("DOM verification", () => {
  const r = fakeResult();
  const scale = 2; // font size 40 px vs 20 px sampling font
  const good = {
    fontSize: r.geometry.fontPx * scale,
    texts: ["ab", "", "c"],
    widths: [36, 0, 18],
    samples: [
      [0, 0, 0],
      [0, 1, 20],
      [2, 2, 0],
    ] as [number, number, number][],
    baseline: r.geometry.baselinePx * scale,
  };

  it("passes a faithful layout", () => {
    const c = evaluateDom(r, good);
    expect(c).toMatchObject({ pass: true, textMatches: true, maxWidthError: 0, maxPositionError: 0, checkedGlyphs: 3 });
  });

  it("fails on drift, wrong text, missing lines or a shifted baseline", () => {
    expect(evaluateDom(r, { ...good, widths: [38, 0, 18] })).toMatchObject({ pass: false, worstRow: 0 });
    const drift = evaluateDom(r, { ...good, samples: [[0, 1, 23]] });
    expect(drift.pass).toBe(false);
    expect(drift.maxPositionError).toBe(3);
    expect(evaluateDom(r, { ...good, texts: ["ab", "", "d"] })).toMatchObject({ pass: false, textMatches: false });
    expect(evaluateDom(r, { ...good, texts: ["ab"] }).pass).toBe(false);
    expect(evaluateDom(r, { ...good, baseline: good.baseline + 5 }).pass).toBe(false);
    expect(evaluateDom(r, { ...good, baseline: null }).pass).toBe(true);
    // Tiny sub pixel differences are tolerated.
    expect(evaluateDom(r, { ...good, widths: [36.4, 0, 18], samples: [[0, 1, 20.4]] }).pass).toBe(true);
    expect(domTolerance(10)).toBe(0.5);
    expect(domTolerance(1000)).toBe(1);
    expect(baselineTolerance(10)).toBe(1);
    expect(baselineTolerance(100)).toBe(3);
  });
});

describe("ui helpers", () => {
  it("escapes Markdown", () => {
    expect(escapeMarkdown("*a_b* [x](y) #1 `c` \\ |t| ~s~ <h> 1. +-!")).toBe(
      "\\*a\\_b\\* \\[x\\]\\(y\\) \\#1 \\`c\\` \\\\ \\|t\\| \\~s\\~ \\<h\\> 1\\. \\+\\-\\!",
    );
    // Everything else, including whitespace, line breaks and non-ASCII, stays.
    expect(escapeMarkdown("ab 09\n\u2588 \u3000z")).toBe("ab 09\n\u2588 \u3000z");
    const all = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
    const escaped = escapeMarkdown(all);
    expect(escaped.replace(/\\(.)/g, "$1")).toBe(all);
    expect((escaped.match(/\\/g) ?? []).length).toBe(33); // 32 escapes plus the escaped backslash itself
  });

  it("keeps text ASCII", () => {
    expect(asciiOnly("caf\u00e9 \u6f22 ok~")).toBe("caf? ? ok~");
    expect(asciiOnly("tab\there")).toBe("tab?here");
    expect(plural(1, "line")).toBe("1 line");
    expect(plural(1234, "line")).toBe("1,234 lines");
  });

  it("summarizes exclusion rules compactly", () => {
    const s = summarizeExclusions([
      { kind: "category", key: "Mn", description: "marks" },
      { kind: "category", key: "Cc", description: "controls" },
      { kind: "bidi", key: "LRE", description: "embedding" },
      { kind: "bidi", key: "RLE", description: "embedding" },
      { kind: "range", key: "U+0590-U+08FF", description: "RTL" },
      { kind: "grapheme", key: "Grapheme_Cluster_Break", description: "joiners" },
    ]);
    expect(s.grapheme).toBe("joiners");
    expect(s.categories).toBe("Mn (marks), Cc (controls)");
    expect(s.bidi).toBe("LRE/RLE (embedding)");
    expect(s.ranges).toEqual([{ key: "U+0590-U+08FF", description: "RTL" }]);
  });

  it("validates options", () => {
    expect(readOptions("80", "10", true)).toEqual({ widthCells: 80, detail: 10, invert: true });
    expect(readOptions("0", "10", false)).toMatch(/Max width/);
    expect(readOptions("1001", "10", false)).toMatch(/Max width/);
    expect(readOptions("1.5", "10", false)).toMatch(/Max width/);
    expect(readOptions("", "10", false)).toMatch(/Max width/);
    expect(readOptions("10", "1", false)).toMatch(/Detail/);
    expect(readOptions("10", " ", false)).toMatch(/Detail/);
    expect(readOptions("10", "33", false)).toMatch(/Detail/);
  });

  it("classifies dropped and pasted files", () => {
    expect(classifyFile({ name: "a.TTF", type: "" })).toBe("font");
    expect(classifyFile({ name: "a.woff2", type: "application/octet-stream" })).toBe("font");
    expect(classifyFile({ name: "x", type: "font/otf" })).toBe("font");
    expect(classifyFile({ name: "p.jpeg", type: "" })).toBe("image");
    expect(classifyFile({ name: "x", type: "image/png" })).toBe("image");
    expect(classifyFile({ name: "notes.txt", type: "text/plain" })).toBeNull();
    const file = (n: string) => ({ name: n }) as File;
    const items = [
      { kind: "string", type: "text/plain", getAsFile: () => null },
      { kind: "file", type: "image/png", getAsFile: () => file("1") },
      { kind: "file", type: "application/pdf", getAsFile: () => file("pdf") },
      { kind: "file", type: "image/jpeg", getAsFile: () => file("2") },
      { kind: "file", type: "image/gif", getAsFile: () => null },
    ];
    expect(imageFromItems(items)?.name).toBe("2");
    expect(imageFromItems([])).toBeNull();
  });

  it("limits decoded image sizes", () => {
    expect(limitSize(100, 50)).toEqual({ width: 100, height: 50 });
    expect(limitSize(8192, 4096)).toEqual({ width: 4096, height: 2048 });
    expect(limitSize(10000, 1, 100)).toEqual({ width: 100, height: 1 });
  });

  it("computes drop positions", () => {
    expect(dropIndex(0, 2, false)).toBe(1);
    expect(dropIndex(0, 2, true)).toBe(2);
    expect(dropIndex(3, 1, false)).toBe(1);
    expect(dropIndex(3, 1, true)).toBe(2);
    expect(dropIndex(2, 2, true)).toBe(2);
  });

  it("fits the output exactly in its box", () => {
    expect(fitFontSize({ boxW: 800, boxH: 600, contentWEm: 40, contentHEm: 20 })).toBe(20);
    expect(fitFontSize({ boxW: 800, boxH: 100, contentWEm: 40, contentHEm: 20 })).toBe(5);
    expect(fitFontSize({ boxW: 0, boxH: 100, contentWEm: 40, contentHEm: 20 })).toBe(0);
    const r = fakeResult();
    expect(contentSizeEm(r)).toEqual({ contentWEm: 18 / 20, contentHEm: 3 * r.geometry.lineHeightEm });
    r.layout.rowWidths.fill(0);
    expect(contentSizeEm(r).contentWEm).toBe(r.geometry.widthPx / r.geometry.fontPx);
  });

  it("places popovers inside the viewport", () => {
    const vp = { width: 400, height: 800 };
    expect(placePanel({ left: 100, right: 120, top: 50, bottom: 70 }, vp, 200, "start")).toEqual({
      left: 100,
      top: 76,
      width: 200,
      maxHeight: 716,
    });
    // Too wide: shrinks to the viewport and clamps.
    expect(placePanel({ left: 300, right: 320, top: 50, bottom: 70 }, vp, 1000, "start")).toMatchObject({ left: 8, width: 384 });
    expect(placePanel({ left: 300, right: 390, top: 50, bottom: 70 }, vp, 200, "end").left).toBe(190);
    // Near the bottom it opens upwards.
    const up = placePanel({ left: 10, right: 30, top: 700, bottom: 720 }, vp, 200, "start");
    expect(up.top + up.maxHeight).toBeLessThanOrEqual(700);
  });

  it("breaks down the conversion time", () => {
    const rows = timingRows(fakeResult(), 40);
    expect(rows.map((r) => r.label)).toEqual([
      "Measuring characters",
      "Rasterizing and packing glyphs",
      "Preparing image (WASM)",
      "Matching glyphs (WebGPU)",
      "Laying out rows (WASM)",
      "Other",
    ]);
    expect(rows.map((r) => r.ms)).toEqual([5, 0, 3, 10, 2, 20]);
    expect(rows[1].note).toBe("reused");
    expect(rows[0].note).toBeUndefined();
    expect(timingRows(fakeResult(), 1).at(-1)?.ms).toBe(0);
    expect(formatMs(12.4)).toBe("12 ms");
    expect(formatMs(1234)).toBe("1.23 s");
  });

  it("explains errors", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    const rt = new Error("unreachable");
    rt.name = "RuntimeError";
    expect(errorText(rt)).toMatch(/too large/);
    expect(errorText(new RangeError("Array buffer allocation failed"))).toMatch(/memory/);
    expect(errorText("plain")).toBe("plain");
  });
});

describe("backend plumbing", () => {
  it("concatenates per batch layouts", () => {
    const a = { ...fakeResult().layout };
    const b = {
      glyphs: Uint32Array.from([7]),
      positions: Float32Array.from([0]),
      rowOffsets: Uint32Array.from([0, 1]),
      rowWidths: Float32Array.from([5]),
      totalCost: 1,
      ms: { score: 1, solve: 1 },
    };
    const c = concatLayouts([a, b]);
    expect([...c.glyphs]).toEqual([0, 1, 2, 7]);
    expect([...c.rowOffsets]).toEqual([0, 2, 2, 3, 4]);
    expect([...c.rowWidths]).toEqual([18, 0, 9, 5]);
    expect(c.totalCost).toBe(5);
    expect(c.ms).toEqual({ score: 11, solve: 3 });
    expect(concatLayouts([]).rowOffsets).toEqual(Uint32Array.from([0]));
  });

  it("recognizes cancellation", () => {
    expect(isAbort(new AbortedError())).toBe(true);
    expect(isAbort(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbort(new Error("x"))).toBe(false);
    const c = new AbortController();
    expect(() => throwIfAborted(c.signal)).not.toThrow();
    c.abort();
    expect(() => throwIfAborted(c.signal)).toThrow(AbortedError);
    expect(() => throwIfAborted()).not.toThrow();
  });

  it("selects the first supported backend and never falls back silently", async () => {
    const make = (id: string, ok: boolean, fails = false): BackendFactory => ({
      id,
      label: id,
      probe: async () => (ok ? { ok: true } : { ok: false, reasons: [`${id} missing`] }),
      create: async () => {
        if (fails) throw new Error(`${id} broke`);
        return { id } as never;
      },
    });
    const none = await selectBackend([make("gpu", false)]);
    expect(none).toEqual({ ok: false, failures: [{ label: "gpu", reasons: ["gpu missing"] }] });
    const broken = await selectBackend([make("gpu", true, true)]);
    expect(broken).toEqual({ ok: false, failures: [{ label: "gpu", reasons: ["gpu broke"] }] });
    const later = await selectBackend([make("a", false), make("b", true)]);
    expect(later.ok && later.backend.id).toBe("b");
    expect(await selectBackend([])).toEqual({ ok: false, failures: [] });
  });
});
