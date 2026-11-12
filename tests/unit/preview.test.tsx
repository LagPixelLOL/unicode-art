// @vitest-environment happy-dom
// The live preview hook: coalescing, image changes, errors and cancellation.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Preview, SourceImage } from "../../src/art/generate";
import { AbortedError } from "../../src/engine/backend";
import { PREVIEW_SIDE, type PreviewParams, usePreview } from "../../src/ui/usePreview";
import { greyToRgba } from "../../src/ui/PreviewCanvas";

const img = (id: number) => ({ id, name: `${id}`, width: 4, height: 2, limited: false, rgba: new Uint8ClampedArray(32) }) as SourceImage;
const params = (contrast: number): PreviewParams => ({ widthCells: 10, preprocess: { invert: false, contrast, edges: 0 } });

/** A generator whose previews finish only when released, in order. */
function gatedGenerator() {
  const calls: { image: SourceImage; params: PreviewParams; side: number; signal?: AbortSignal; resolve(p: Preview): void; reject(e: unknown): void }[] = [];
  const generator = {
    preview: vi.fn(
      (image: SourceImage, p: PreviewParams, side: number, signal?: AbortSignal) =>
        new Promise<Preview>((resolve, reject) => calls.push({ image, params: p, side, signal, resolve, reject })),
    ),
  };
  const finish = async (k: number) => {
    const c = calls[k];
    await act(async () => c.resolve({ width: 1, height: 1, grey: Float32Array.of(c.params.preprocess.contrast) }));
  };
  return { generator, calls, finish };
}

describe("usePreview", () => {
  it("runs one preview at a time and folds changes into the next one", async () => {
    const { generator, calls, finish } = gatedGenerator();
    const image = img(1);
    const { result, rerender } = renderHook(({ p }) => usePreview(generator, image, p), { initialProps: { p: params(0.1) } });
    expect(calls).toHaveLength(1);
    expect(calls[0].side).toBe(PREVIEW_SIDE);
    expect(result.current).toMatchObject({ preview: null, busy: true });
    // Dragging a slider: many changes while the first preview runs.
    for (const c of [0.2, 0.3, 0.4]) rerender({ p: params(c) });
    expect(calls).toHaveLength(1);
    await finish(0);
    expect(result.current.preview?.grey[0]).toBeCloseTo(0.1);
    expect(result.current.busy).toBe(true);
    // Only the latest settings run next.
    expect(calls).toHaveLength(2);
    expect(calls[1].params.preprocess.contrast).toBe(0.4);
    await finish(1);
    expect(result.current).toMatchObject({ busy: false, error: null });
    expect(result.current.preview?.grey[0]).toBeCloseTo(0.4);
    // Same settings again: nothing to do.
    rerender({ p: params(0.4) });
    expect(calls).toHaveLength(2);
  });

  it("never shows another image's preview and keeps the last one while options are invalid", async () => {
    const { calls, generator, finish } = gatedGenerator();
    const { result, rerender } = renderHook(({ image, p }) => usePreview(generator, image, p), {
      initialProps: { image: img(1) as SourceImage | null, p: params(0.5) as PreviewParams | null },
    });
    await finish(0);
    expect(result.current.preview?.imageId).toBe(1);
    // A new object for the same image with the same settings is no change.
    rerender({ image: img(1), p: params(0.5) });
    expect(calls).toHaveLength(1);
    rerender({ image: img(1), p: null });
    expect(calls).toHaveLength(1);
    expect(result.current.preview?.imageId).toBe(1);
    rerender({ image: img(2), p: params(0.5) });
    expect(result.current.preview).toBeNull();
    await finish(1);
    expect(result.current.preview?.imageId).toBe(2);
    rerender({ image: null, p: params(0.5) });
    expect(result.current).toEqual({ preview: null, busy: false, error: null });
  });

  it("reports errors, ignores aborts and stops when unmounted", async () => {
    const { calls, generator, finish } = gatedGenerator();
    const { result, rerender, unmount } = renderHook(({ p }) => usePreview(generator, img(1), p), { initialProps: { p: params(0.5) } });
    await finish(0);
    rerender({ p: params(0.6) });
    await act(async () => calls[1].reject(new Error("GPU says no")));
    expect(result.current.error).toBe("GPU says no");
    expect(result.current.preview?.grey[0]).toBeCloseTo(0.5);
    rerender({ p: params(0.7) });
    expect(result.current.error).toBeNull();
    await act(async () => calls[2].reject(new AbortedError()));
    expect(result.current.error).toBeNull();
    rerender({ p: params(0.8) });
    const signal = calls[3].signal!;
    unmount();
    expect(signal.aborted).toBe(true);
    await finish(3);
  });
});

describe("preview pixels", () => {
  it("turns grey brightness into opaque pixels", () => {
    expect([...greyToRgba(Float32Array.of(0, 0.5, 1))]).toEqual([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
  });
});
