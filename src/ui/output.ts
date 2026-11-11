// Native rendering of the result, scaled to fit its box exactly.

import type { ArtResult } from "../art/generate";
import type { DomMeasurements } from "../art/verify";

export interface FitInput {
  boxW: number;
  boxH: number;
  contentWEm: number;
  contentHEm: number;
}

/** Font size that makes the content touch the box on at least one axis. */
export function fitFontSize({ boxW, boxH, contentWEm, contentHEm }: FitInput): number {
  if (!(boxW > 0 && boxH > 0 && contentWEm > 0 && contentHEm > 0)) return 0;
  return Math.min(boxW / contentWEm, boxH / contentHEm);
}

const SAMPLES_PER_ROW = 16;

export class OutputView {
  private readonly content: HTMLDivElement;
  private lineEls: HTMLDivElement[] = [];
  private result: ArtResult | null = null;
  fontSize = 0;

  constructor(
    private readonly box: HTMLElement,
    private readonly placeholder: HTMLElement,
    onResize: () => void,
  ) {
    this.content = document.createElement("div");
    this.content.className = "art-text absolute text-zinc-100 whitespace-pre";
    this.content.setAttribute("data-testid", "output-text");
    box.append(this.content);
    let pending = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        if (this.result) {
          this.fit();
          onResize();
        }
      });
    }).observe(box);
  }

  get current(): ArtResult | null {
    return this.result;
  }

  clear(message: string): void {
    this.result = null;
    this.content.replaceChildren();
    this.lineEls = [];
    this.placeholder.textContent = message;
    this.placeholder.hidden = false;
  }

  show(result: ArtResult): void {
    this.result = result;
    this.placeholder.hidden = true;
    const lh = `${result.geometry.lineHeightEm}em`;
    this.content.style.fontFamily = result.families.map((f) => `"${f}"`).join(", ");
    this.lineEls = result.lines.map((text) => {
      const div = document.createElement("div");
      div.style.height = lh;
      div.style.lineHeight = lh;
      div.textContent = text;
      return div;
    });
    this.content.replaceChildren(...this.lineEls);
    this.fit();
  }

  private apply(size: number, contentWEm: number, contentHEm: number): void {
    this.fontSize = size;
    this.content.style.fontSize = `${size}px`;
    this.content.style.left = `${(this.box.clientWidth - contentWEm * size) / 2}px`;
    this.content.style.top = `${(this.box.clientHeight - contentHEm * size) / 2}px`;
  }

  fit(): void {
    const r = this.result;
    if (!r) return;
    const geo = r.geometry;
    const widest = Math.max(0, ...r.layout.rowWidths);
    const contentWEm = (widest || geo.widthPx) / geo.fontPx;
    const contentHEm = r.rows * geo.lineHeightEm;
    const boxW = this.box.clientWidth;
    const boxH = this.box.clientHeight;
    let size = fitFontSize({ boxW, boxH, contentWEm, contentHEm });
    this.apply(size, contentWEm, contentHEm);
    // Correct for any rounding the browser applies to the native layout.
    for (let i = 0; i < 3 && size > 0; i++) {
      const w = Math.max(0, ...this.lineWidths());
      const h = this.content.getBoundingClientRect().height;
      const k = Math.min(w > boxW ? boxW / w : 1, h > boxH ? boxH / h : 1);
      if (k >= 1) break;
      size *= k * 0.9999;
      this.apply(size, contentWEm, contentHEm);
    }
  }

  private lineWidths(): number[] {
    const range = document.createRange();
    return this.lineEls.map((el) => {
      const node = el.firstChild;
      if (!node) return 0;
      range.selectNodeContents(node);
      return range.getBoundingClientRect().width;
    });
  }

  /** Measures what the browser actually laid out, for verification. */
  measure(): DomMeasurements {
    const r = this.result;
    if (!r) throw new Error("Nothing rendered");
    const range = document.createRange();
    const samples: [number, number, number][] = [];
    for (let row = 0; row < r.rows; row++) {
      const node = this.lineEls[row].firstChild;
      const a = r.layout.rowOffsets[row];
      const b = r.layout.rowOffsets[row + 1];
      if (!node || b === a) continue;
      const left = this.lineEls[row].getBoundingClientRect().left;
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
    const first = this.lineEls[0];
    if (first) {
      const probe = document.createElement("span");
      probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
      first.append(probe);
      baseline = probe.getBoundingClientRect().top - first.getBoundingClientRect().top;
      probe.remove();
    }
    return {
      fontSize: this.fontSize,
      texts: this.lineEls.map((el) => el.textContent ?? ""),
      widths: this.lineWidths(),
      samples,
      baseline,
    };
  }
}
