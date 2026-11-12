// @vitest-environment happy-dom
// The conversion hook: results, clearing and cancellation, with the pipeline mocked.

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ArtResult } from "../../src/art/generate";
import type { FontStore } from "../../src/fonts/store";
import { NoticeProvider } from "../../src/ui/notices";
import { useConversion } from "../../src/ui/useConversion";

const fake = { result: null as unknown as ArtResult, gate: Promise.resolve() };

vi.mock("../../src/art/generate", () => ({
  ArtGenerator: class {
    async generate(_f: unknown, _i: unknown, _o: unknown, signal?: AbortSignal) {
      await fake.gate;
      signal?.throwIfAborted();
      return fake.result;
    }
    dispose() {}
  },
}));
vi.mock("../../src/art/verify", () => ({
  verifyCanvas: async () => ({ pass: true, similarity: 1, worstRow: -1, worstRowSimilarity: 1, badRows: 0 }),
}));

const store = { ensureReady: async () => [], ready: [{ id: 1 }] } as unknown as FontStore;
const inputs = { image: { id: 1 } as never, options: { widthCells: 10, detail: 4, preprocess: { invert: false, contrast: 0.5, edges: 0.5 } } };
const wrapper = ({ children }: { children: ReactNode }) => <NoticeProvider>{children}</NoticeProvider>;

describe("useConversion", () => {
  it("clears the previous result and stats as soon as a new run starts", async () => {
    const { result } = renderHook(() => useConversion({} as never, store), { wrapper });
    fake.result = { text: "first" } as ArtResult;
    await act(() => result.current.start(inputs));
    expect(result.current.state.kind).toBe("done");
    expect(result.current.result?.text).toBe("first");
    expect(result.current.canvasCheck?.pass).toBe(true);
    expect(result.current.lastTotalMs).not.toBeNull();
    expect(result.current.verifyMs).not.toBeNull();

    let release!: () => void;
    fake.gate = new Promise((r) => (release = r));
    fake.result = { text: "second" } as ArtResult;
    let run!: Promise<void>;
    act(() => {
      run = result.current.start(inputs);
    });
    expect(result.current.running).toBe(true);
    expect(result.current.result).toBeNull();
    expect(result.current.canvasCheck).toBeNull();
    expect(result.current.lastTotalMs).toBeNull();
    expect(result.current.verifyMs).toBeNull();
    release();
    await act(() => run);
    expect(result.current.result?.text).toBe("second");
  });

  it("cancels immediately and can clear on demand", async () => {
    const { result } = renderHook(() => useConversion({} as never, store), { wrapper });
    let release!: () => void;
    fake.gate = new Promise((r) => (release = r));
    let run!: Promise<void>;
    act(() => {
      run = result.current.start(inputs);
    });
    act(() => result.current.cancel());
    expect(result.current.state.kind).toBe("cancelled");
    release();
    await act(() => run);
    expect(result.current.state.kind).toBe("cancelled");
    expect(result.current.result).toBeNull();

    fake.gate = Promise.resolve();
    fake.result = { text: "x" } as ArtResult;
    await act(() => result.current.start(inputs));
    act(() => result.current.clear());
    expect(result.current.result).toBeNull();
    expect(result.current.state.kind).toBe("idle");
  });
});
