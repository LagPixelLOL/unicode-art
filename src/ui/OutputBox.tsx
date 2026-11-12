// Native rendering of the result, scaled so it fits its box exactly.

import { useLayoutEffect, useRef } from "react";
import type { ArtResult } from "../art/generate";
import type { DomMeasurements } from "../art/verify";

export interface FitInput {
  boxW: number;
  boxH: number;
  contentWEm: number;
  contentHEm: number;
}

/** Smallest font size the output is laid out at; smaller sizes are scaled down. */
export const MIN_LAYOUT_FONT_PX = 128;

/**
 * Browsers position glyphs with a fixed precision (font sizes and advances
 * snap to fractions such as 1/64 px). Those errors are absolute, so at small
 * font sizes they add up along a line to a visible drift. The output is
 * therefore laid out at a large font size that is a multiple of 1/64 px and
 * scaled to the wanted size with a transform, which keeps the native layout
 * proportional to the computed one.
 */
export function splitFontSize(size: number): { layout: number; scale: number } {
  if (!(size > 0)) return { layout: size, scale: 1 };
  const layout = size >= MIN_LAYOUT_FONT_PX ? Math.floor(size * 64) / 64 : MIN_LAYOUT_FONT_PX;
  return { layout, scale: size / layout };
}

/** Font size that makes the content touch the box on at least one axis. */
export function fitFontSize({ boxW, boxH, contentWEm, contentHEm }: FitInput): number {
  if (!(boxW > 0 && boxH > 0 && contentWEm > 0 && contentHEm > 0)) return 0;
  return Math.min(boxW / contentWEm, boxH / contentHEm);
}

/** The sampled image's frame: rows may end early where only blanks would follow. */
export function contentSizeEm(r: ArtResult): { contentWEm: number; contentHEm: number } {
  const widest = r.layout.rowWidths.reduce((m, w) => Math.max(m, w), 0);
  return {
    contentWEm: Math.max(widest, r.geometry.widthPx) / r.geometry.fontPx,
    contentHEm: r.rows * r.geometry.lineHeightEm,
  };
}

const SAMPLES_PER_ROW = 16;

function lineWidths(lines: HTMLElement[]): number[] {
  const range = document.createRange();
  return lines.map((el) => {
    const node = el.firstChild;
    if (!node) return 0;
    range.selectNodeContents(node);
    return range.getBoundingClientRect().width;
  });
}

/** What the browser actually laid out, for verification. */
export function measureLines(lines: HTMLElement[], r: ArtResult, fontSize: number): DomMeasurements {
  const range = document.createRange();
  const samples: [number, number, number][] = [];
  for (let row = 0; row < r.rows; row++) {
    const node = lines[row]?.firstChild;
    const a = r.layout.rowOffsets[row];
    const b = r.layout.rowOffsets[row + 1];
    if (!node || b === a) continue;
    const left = lines[row].getBoundingClientRect().left;
    const step = Math.max(1, Math.floor((b - a) / SAMPLES_PER_ROW));
    let offset = 0;
    for (let i = a; i < b; i++) {
      const len = r.glyphCodepoint[r.layout.glyphs[i]] > 0xffff ? 2 : 1;
      if ((i - a) % step === 0 || i === b - 1) {
        range.setStart(node, offset);
        range.setEnd(node, offset + len);
        samples.push([row, i, range.getBoundingClientRect().left - left]);
      }
      offset += len;
    }
  }
  let baseline: number | null = null;
  const first = lines[0];
  if (first) {
    const probe = document.createElement("span");
    probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
    first.append(probe);
    baseline = probe.getBoundingClientRect().top - first.getBoundingClientRect().top;
    probe.remove();
  }
  return { fontSize, texts: lines.map((el) => el.textContent ?? ""), widths: lineWidths(lines), samples, baseline };
}

interface Props {
  result: ArtResult | null;
  placeholder: string;
  busy: boolean;
  /** Called after every layout (new result or resize). */
  onLayout(m: DomMeasurements): void;
}

export function OutputBox({ result, placeholder, busy, onLayout }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const onLayoutRef = useRef(onLayout);
  onLayoutRef.current = onLayout;

  useLayoutEffect(() => {
    const b = box.current;
    const c = content.current;
    if (!b || !c || !result) return;
    const { contentWEm, contentHEm } = contentSizeEm(result);
    const lines = Array.from(c.children) as HTMLElement[];
    const apply = (size: number) => {
      const { layout, scale } = splitFontSize(size);
      c.style.fontSize = `${layout}px`;
      c.style.transform = scale === 1 ? "" : `scale(${scale})`;
      c.style.left = `${(b.clientWidth - contentWEm * size) / 2}px`;
      c.style.top = `${(b.clientHeight - contentHEm * size) / 2}px`;
    };
    const fit = () => {
      const boxW = b.clientWidth;
      const boxH = b.clientHeight;
      let size = fitFontSize({ boxW, boxH, contentWEm, contentHEm });
      apply(size);
      // Correct for any rounding the browser applies to the native layout.
      for (let i = 0; i < 3 && size > 0; i++) {
        const w = Math.max(0, ...lineWidths(lines));
        const h = c.getBoundingClientRect().height;
        const k = Math.min(w > boxW ? boxW / w : 1, h > boxH ? boxH / h : 1);
        if (k >= 1) break;
        size *= k * 0.9999;
        apply(size);
      }
      if (size > 0) onLayoutRef.current(measureLines(lines, result, size));
    };
    fit();
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    ro.observe(b);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [result]);

  const lh = result ? `${result.geometry.lineHeightEm}em` : undefined;
  return (
    <div ref={box} className="relative min-h-0 flex-1 overflow-hidden rounded-md bg-black" data-testid="output-box">
      {result ? (
        <div
          ref={content}
          className="art-text absolute origin-top-left whitespace-pre text-zinc-100"
          data-testid="output-text"
          style={{ fontFamily: result.families.map((f) => `"${f}"`).join(", ") }}
        >
          {result.lines.map((line, i) => (
            <div key={i} style={{ height: lh, lineHeight: lh }}>
              {line}
            </div>
          ))}
        </div>
      ) : (
        <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-zinc-600">
          {placeholder}
        </p>
      )}
      {busy && result && (
        <div className="pointer-events-none absolute top-2 right-2 rounded bg-zinc-900/80 px-2 py-0.5 text-xs text-zinc-400">
          Updating...
        </div>
      )}
    </div>
  );
}
