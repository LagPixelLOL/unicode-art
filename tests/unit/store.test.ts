// The font list: immediate and lazily downloaded fonts, priority and cleanup.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebGpuWasmBackend } from "../../src/engine/webgpu-wasm/backend";
import type { FontSource } from "../../src/fonts/sources";
import { FontStore, type RemoteLoader } from "../../src/fonts/store";
import { fixture, loadCore } from "./helpers/core";

const registered = new Set<FakeFace>();
/** The fake browser refuses faces declared with this range. */
const REJECTED_RANGE = "U+0000-0001";

class FakeFace {
  constructor(
    readonly family: string,
    readonly data: ArrayBuffer,
    readonly descriptors: { unicodeRange?: string } = {},
  ) {}
  async load() {
    if (this.descriptors.unicodeRange === REJECTED_RANGE) throw new Error("rejected");
    return this;
  }
}

Object.assign(globalThis, {
  FontFace: FakeFace,
  document: { fonts: { add: (f: FakeFace) => registered.add(f), delete: (f: FakeFace) => registered.delete(f) } },
});

const backend = new WebGpuWasmBackend(loadCore(), {
  limits: {},
  lost: new Promise(() => {}),
  createBindGroupLayout: () => ({}),
} as unknown as GPUDevice);

const src = (name: string, file: string, unicodeRange: string | null = null, preferFamilyName = false): FontSource => ({
  name,
  faces: [{ bytes: fixture(file), unicodeRange, label: file }],
  preferFamilyName,
});

function remote(map: Record<string, FontSource>, calls: string[][] = []): RemoteLoader {
  return async (families, signal, onProgress) => {
    calls.push([...families]);
    onProgress(0, families.length);
    signal?.throwIfAborted();
    const fonts = families.flatMap((f) => (map[f] ? [map[f]] : []));
    onProgress(families.length, families.length);
    return { fonts, warnings: families.filter((f) => !map[f]).map((f) => `${f}: missing`) };
  };
}

beforeEach(() => {
  registered.clear();
});

describe("FontStore", () => {
  it("adds fonts immediately and registers every face", async () => {
    const store = new FontStore(backend, remote({}));
    const listener = vi.fn();
    store.subscribe(listener);
    const r = await store.add(src("sans.ttf", "sans.ttf", null, true));
    expect(r.warnings).toEqual([]);
    expect(r.font?.name).toBe("Fixture Sans");
    expect(store.entries[0]).toMatchObject({ status: "ready", name: "Fixture Sans", family: "uaf-1" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registered.size).toBe(1);
    expect(store.ready.map((f) => f.family)).toEqual(["uaf-1"]);
    const font = store.ready[0];
    expect(font.coverage.length).toBeGreaterThan(90);
    expect(font.ascentEm).toBeGreaterThan(0.8);
    expect(font.descentEm).toBeGreaterThan(0.1);
    expect(font.formats).toEqual(["ttf"]);
  });

  it("registers collections through their extracted face and keeps face ranges", async () => {
    const store = new FontStore(backend, remote({}));
    await store.add(src("c.ttc", "collection.ttc"));
    const face = [...registered][0];
    expect(new Uint8Array(face.data).slice(0, 4)).toEqual(new Uint8Array([0, 1, 0, 0]));
    await store.add({
      name: "Split",
      faces: [
        { bytes: fixture("sans.ttf"), unicodeRange: "U+0041-005A", label: "upper" },
        { bytes: fixture("mono.ttf"), unicodeRange: "U+0061-007A", label: "lower" },
      ],
    });
    const split = store.ready[1];
    expect(split.faces).toHaveLength(2);
    expect([...split.coverage].every((cp) => (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a))).toBe(true);
    expect([...registered].filter((f) => f.family === split.family).map((f) => f.descriptors.unicodeRange)).toEqual([
      "U+0041-005A",
      "U+0061-007A",
    ]);
  });

  it("reports broken faces but keeps the usable ones", async () => {
    const store = new FontStore(backend, remote({}));
    const r = await store.add({
      name: "Mixed",
      faces: [
        { bytes: new Uint8Array([1, 2, 3, 4]), unicodeRange: null, label: "junk" },
        { bytes: fixture("sans.ttf"), unicodeRange: "nonsense", label: "range" },
        { bytes: fixture("mono.ttf"), unicodeRange: null, label: "good" },
        { bytes: fixture("sans.ttf"), unicodeRange: REJECTED_RANGE, label: "rejected" },
      ],
    });
    expect(r.font?.faces).toHaveLength(1);
    expect(r.warnings).toHaveLength(3);
    expect(r.warnings[0]).toMatch(/Mixed \(junk\): not a TTF/);
    expect(r.warnings[1]).toMatch(/invalid unicode-range/);
    expect(r.warnings[2]).toMatch(/Mixed \(rejected\): the browser rejected/);
    const none = await store.add(src("junk", "OFL.txt"));
    expect(none.font).toBeNull();
    expect(store.entries).toHaveLength(1);
    const color = await store.add(src("color", "color.ttf"));
    expect(color.warnings).toEqual([]);
    expect(color.font?.colorGlyphs).toBe(2);
  });

  it("lists preset fonts without downloading, then loads them on demand", async () => {
    const calls: string[][] = [];
    const store = new FontStore(backend, remote({ A: src("A", "sans.ttf"), B: src("B", "mono.ttf") }, calls));
    await store.add(src("old", "variable.ttf"));
    store.setRemote(["A", "Missing", "B"]);
    expect(registered.size).toBe(0);
    expect(store.entries.map((e) => [e.name, e.status])).toEqual([
      ["A", "pending"],
      ["Missing", "pending"],
      ["B", "pending"],
    ]);
    expect(calls).toEqual([]);
    expect(store.pendingCount).toBe(3);
    expect(store.ready).toEqual([]);

    store.move(2, 0);
    const phases = new Set<string>();
    const warnings = await store.ensureReady(undefined, (phase) => phases.add(phase));
    expect(calls).toEqual([["B", "A", "Missing"]]);
    expect(warnings).toEqual(["Missing: missing"]);
    expect([...phases]).toEqual(["Downloading fonts", "Registering fonts"]);
    expect(store.entries.map((e) => [e.name, e.status])).toEqual([
      ["B", "ready"],
      ["A", "ready"],
      ["Missing", "failed"],
    ]);
    expect(store.ready.map((f) => f.name)).toEqual(["B", "A"]);
    // Registered under the family allocated when listed.
    expect(store.ready[0].family).toBe(store.entries[0].family);
    // Nothing left to download.
    expect(await store.ensureReady()).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("returns fonts to pending when loading is cancelled and serializes loads", async () => {
    const store = new FontStore(backend, remote({ A: src("A", "sans.ttf") }));
    store.setRemote(["A"]);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(store.ensureReady(ctrl.signal)).rejects.toThrow();
    expect(store.entries[0].status).toBe("pending");
    const late = new AbortController();
    const first = store.ensureReady(late.signal, (phase) => phase === "Registering fonts" && late.abort());
    const second = store.ensureReady();
    await expect(first).rejects.toThrow();
    await second;
    expect(store.entries[0].status).toBe("ready");
  });

  it("removes, reorders and replaces fonts, unregistering their faces", async () => {
    const store = new FontStore(backend, remote({}));
    await store.add(src("a", "sans.ttf"));
    await store.add(src("b", "mono.ttf"));
    await store.add(src("c", "variable.ttf"));
    expect(registered.size).toBe(3);
    store.move(0, 2);
    expect(store.entries.map((e) => e.name)).toEqual(["b", "c", "a"]);
    const listener = vi.fn();
    store.subscribe(listener);
    store.move(1, 1);
    store.remove(999);
    expect(listener).not.toHaveBeenCalled();
    store.remove(store.entries[0].id);
    expect(store.entries.map((e) => e.name)).toEqual(["c", "a"]);
    expect(registered.size).toBe(2);
    store.setRemote([]);
    expect(store.entries).toEqual([]);
    expect(registered.size).toBe(0);
  });

  it("drops fonts removed while they were downloading", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const store = new FontStore(backend, async (families) => {
      await gate;
      return { fonts: families.map((f) => src(f, "sans.ttf")), warnings: [] };
    });
    store.setRemote(["A", "B"]);
    const loading = store.ensureReady();
    store.remove(store.entries[0].id);
    release();
    await loading;
    expect(store.entries.map((e) => [e.name, e.status])).toEqual([["B", "ready"]]);
    expect(registered.size).toBe(1);
  });
});
