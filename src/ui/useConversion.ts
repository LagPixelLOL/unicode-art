// Runs the conversion whenever its inputs change, newest run wins.

import { useEffect, useRef, useState } from "react";
import { type ArtOptions, type ArtResult, ArtGenerator, type SourceImage, type Stage } from "../art/generate";
import { type CanvasCheck, verifyCanvas } from "../art/verify";
import { type ComputeBackend, isAbort } from "../engine/backend";
import type { LoadedFont } from "../fonts/store";
import { errorText } from "./notices";

export type ConversionState =
  | { kind: "idle"; reason: string }
  | { kind: "running"; stage: Stage; progress: number }
  | { kind: "done"; seconds: number }
  | { kind: "error"; message: string };

const DEBOUNCE_MS = 200;

export function useConversion(
  backend: ComputeBackend,
  fonts: readonly LoadedFont[],
  image: SourceImage | null,
  options: ArtOptions | string,
  waitingForFonts: boolean,
) {
  const generator = useRef<ArtGenerator | null>(null);
  generator.current ??= new ArtGenerator(backend);
  const [state, setState] = useState<ConversionState>({ kind: "idle", reason: "" });
  const [result, setResult] = useState<ArtResult | null>(null);
  const [canvasCheck, setCanvasCheck] = useState<CanvasCheck | null>(null);
  const optionsKey = typeof options === "string" ? options : JSON.stringify(options);

  useEffect(() => () => generator.current?.dispose(), []);

  useEffect(() => {
    if (typeof options === "string") {
      setState({ kind: "error", message: options });
      return;
    }
    if (fonts.length === 0 || !image) {
      setResult(null);
      setCanvasCheck(null);
      const reason =
        fonts.length === 0
          ? waitingForFonts
            ? "Waiting for the fonts to finish loading."
            : "Add at least one font, or pick a preset."
          : "Upload, paste or drop an image.";
      setState({ kind: "idle", reason });
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      const started = performance.now();
      try {
        setState({ kind: "running", stage: "charset", progress: 0 });
        const r = await generator.current!.generate(fonts, image, options, ctrl.signal, (stage, progress) => {
          if (!ctrl.signal.aborted) setState({ kind: "running", stage, progress });
        });
        if (ctrl.signal.aborted) return;
        setResult(r);
        setCanvasCheck(null);
        setState({ kind: "done", seconds: (performance.now() - started) / 1000 });
        const check = await verifyCanvas(r, backend);
        if (!ctrl.signal.aborted) setCanvasCheck(check);
      } catch (e) {
        if (isAbort(e) || ctrl.signal.aborted) return;
        console.error(e);
        setState({ kind: "error", message: errorText(e) });
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // optionsKey stands in for options.
  }, [backend, fonts, image, optionsKey, waitingForFonts]);

  return { state, result, canvasCheck };
}
