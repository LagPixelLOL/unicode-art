// Conversion runs, started and cancelled explicitly by the user.

import { useCallback, useEffect, useRef, useState } from "react";
import { type ArtOptions, type ArtResult, ArtGenerator, type SourceImage, type Stage } from "../art/generate";
import { type CanvasCheck, verifyCanvas } from "../art/verify";
import { type ComputeBackend, isAbort } from "../engine/backend";
import type { FontStore } from "../fonts/store";
import { errorText, useNotify } from "./notices";
import { plural } from "./text";

export type RunStage = "fonts" | Stage | "verify";

export type ConversionState =
  | { kind: "idle" }
  | { kind: "running"; stage: RunStage; progress: number; detail: string }
  | { kind: "done"; totalMs: number }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export interface RunInputs {
  image: SourceImage;
  options: ArtOptions;
}

export function useConversion(backend: ComputeBackend, store: FontStore) {
  const notify = useNotify();
  const generator = useRef<ArtGenerator | null>(null);
  generator.current ??= new ArtGenerator(backend);
  const current = useRef<AbortController | null>(null);
  const [state, setState] = useState<ConversionState>({ kind: "idle" });
  const [result, setResult] = useState<ArtResult | null>(null);
  const [canvasCheck, setCanvasCheck] = useState<CanvasCheck | null>(null);
  const [verifyMs, setVerifyMs] = useState<number | null>(null);
  const [lastTotalMs, setLastTotalMs] = useState<number | null>(null);

  useEffect(
    () => () => {
      current.current?.abort();
      generator.current?.dispose();
    },
    [],
  );

  const start = useCallback(
    async ({ image, options }: RunInputs) => {
      current.current?.abort();
      const ctrl = new AbortController();
      current.current = ctrl;
      const { signal } = ctrl;
      const set = (s: ConversionState) => {
        if (current.current === ctrl) setState(s);
      };
      const started = performance.now();
      try {
        set({ kind: "running", stage: "fonts", progress: 0, detail: "" });
        const warnings = await store.ensureReady(signal, (phase, done, total) =>
          set({ kind: "running", stage: "fonts", progress: total ? done / total : 0, detail: `${phase} ${done} / ${total}` }),
        );
        if (warnings.length) {
          notify("warning", `Some fonts could not be loaded (${plural(warnings.length, "problem")}).`, warnings);
        }
        const fonts = store.ready;
        if (fonts.length === 0) throw new Error("No font is available. Add a font or pick a preset.");

        const r = await generator.current!.generate(fonts, image, options, signal, (stage, progress) =>
          set({ kind: "running", stage, progress, detail: "" }),
        );
        signal.throwIfAborted();
        const totalMs = performance.now() - started;
        setResult(r);
        setCanvasCheck(null);
        setVerifyMs(null);
        setLastTotalMs(totalMs);

        set({ kind: "running", stage: "verify", progress: 0, detail: "" });
        const verifyStart = performance.now();
        const check = await verifyCanvas(r, backend, signal);
        signal.throwIfAborted();
        setCanvasCheck(check);
        setVerifyMs(performance.now() - verifyStart);
        set({ kind: "done", totalMs });
      } catch (e) {
        if (isAbort(e) || signal.aborted) {
          set({ kind: "cancelled" });
          return;
        }
        console.error(e);
        const message = errorText(e);
        set({ kind: "error", message });
        notify("error", message);
      } finally {
        if (current.current === ctrl) current.current = null;
      }
    },
    [backend, store, notify],
  );

  // Cancelling takes effect in the UI at once; the aborted run unwinds at its
  // next checkpoint and can no longer touch the state.
  const cancel = useCallback(() => {
    current.current?.abort();
    current.current = null;
    setState({ kind: "cancelled" });
  }, []);

  return { state, result, canvasCheck, verifyMs, lastTotalMs, start, cancel, running: state.kind === "running" };
}
