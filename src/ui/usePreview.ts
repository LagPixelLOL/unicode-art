// Live preview of the preprocessed image, updated whenever the image or the
// preprocessing changes. At most one preview runs at a time: changes made in
// the meantime are folded into the next one, so dragging a slider never
// queues up GPU work and the page stays responsive.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ArtGenerator, ArtOptions, Preview, SourceImage } from "../art/generate";
import { isAbort } from "../engine/backend";
import { errorText } from "./notices";

/** Longest side of the preview in pixels, enough for a sharp thumbnail. */
export const PREVIEW_SIDE = 384;

export type PreviewParams = Pick<ArtOptions, "widthCells" | "preprocess">;

export interface PreviewState {
  /** The latest preview, for the image with id `imageId`. */
  preview: (Preview & { imageId: number }) | null;
  /** Whether a newer preview is being computed. */
  busy: boolean;
  error: string | null;
}

const IDLE: PreviewState = { preview: null, busy: false, error: null };

/** `params` is null while the options are invalid; the last preview stays. */
export function usePreview(generator: Pick<ArtGenerator, "preview">, image: SourceImage | null, params: PreviewParams | null): PreviewState {
  const [state, setState] = useState<PreviewState>(IDLE);
  const wanted = useRef<{ image: SourceImage; params: PreviewParams } | null>(null);
  const running = useRef(false);
  const signal = useRef<AbortSignal | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    signal.current = ctrl.signal;
    return () => {
      ctrl.abort();
      wanted.current = null;
    };
  }, []);

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (wanted.current && signal.current && !signal.current.aborted) {
        const job = wanted.current;
        wanted.current = null;
        const sig = signal.current;
        try {
          const p = await generator.preview(job.image, job.params, PREVIEW_SIDE, sig);
          if (sig.aborted) return;
          setState({ preview: { ...p, imageId: job.image.id }, busy: wanted.current !== null, error: null });
        } catch (e) {
          if (isAbort(e) || sig.aborted) return;
          setState((s) => ({ ...s, busy: wanted.current !== null, error: errorText(e) }));
        }
      }
    } finally {
      running.current = false;
    }
  }, [generator]);

  // Keyed by value: equal images and settings never start another preview.
  const latestImage = useRef(image);
  latestImage.current = image;
  const imageId = image?.id ?? null;
  const key = params ? JSON.stringify(params) : null;
  useEffect(() => {
    const current = latestImage.current;
    if (!current) {
      wanted.current = null;
      setState(IDLE);
      return;
    }
    if (key === null) return;
    wanted.current = { image: current, params: JSON.parse(key) as PreviewParams };
    // A preview of another image is never shown next to this one.
    setState((s) => ({ preview: s.preview?.imageId === current.id ? s.preview : null, busy: true, error: null }));
    void pump();
  }, [imageId, key, pump]);

  return state;
}
