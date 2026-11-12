import { useLayoutEffect, useRef } from "react";
import type { Preview } from "../art/generate";

/** Grey sRGB brightness in [0, 1] as opaque RGBA pixels. */
export function greyToRgba(grey: Float32Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(grey.length * 4);
  for (let i = 0; i < grey.length; i++) {
    const v = Math.round(grey[i] * 255);
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function PreviewCanvas({ preview, className }: { preview: Preview; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(new ImageData(greyToRgba(preview.grey), preview.width, preview.height), 0, 0);
  }, [preview]);
  return (
    <canvas
      ref={ref}
      width={preview.width}
      height={preview.height}
      role="img"
      aria-label="Preprocessed image"
      data-testid="preview-canvas"
      className={className}
    />
  );
}
