// A deterministic stand-in for OffscreenCanvas text rendering, so the
// conversion pipeline can run in Node. Fonts are registered by family name
// with per code point advances; each glyph is drawn as a vertical bar whose
// width depends on the code point, so different glyphs look different.

export interface FakeFont {
  advances: Map<number, number>;
  ascentEm: number;
  descentEm: number;
  /** Overrides the ink of this font's glyphs (fonts draw glyphs differently). */
  ink?: (cp: number) => number;
}

export const fakeFonts = new Map<string, FakeFont>();

export const fakeOptions = {
  /** Resolve font stacks from the last family to the first (a broken browser). */
  reverseFallback: false,
  /** Extra advance (em) added by the "browser" to this code point. */
  advanceSkew: new Map<number, number>(),
};

export function resetFake(): void {
  fakeFonts.clear();
  fakeOptions.reverseFallback = false;
  fakeOptions.advanceSkew.clear();
}

function parseFont(font: string): { px: number; families: string[] } {
  const m = /^([\d.]+)px (.*)$/.exec(font);
  if (!m) throw new Error(`bad font ${font}`);
  return { px: Number(m[1]), families: m[2].split(",").map((f) => f.trim().replace(/^"(.*)"$/, "$1")) };
}

function resolve(families: string[], cp: number): FakeFont | null {
  const list = fakeOptions.reverseFallback ? [...families].reverse() : families;
  for (const f of list) {
    const font = fakeFonts.get(f);
    if (font?.advances.has(cp)) return font;
  }
  return null;
}

/** Fraction of the advance covered with ink for a code point. */
export function inkFraction(cp: number): number {
  return cp === 0x20 ? 0 : ((cp * 7) % 11) / 10;
}

class FakeContext {
  font = "10px sans-serif";
  fillStyle = "#000";
  textBaseline = "alphabetic";
  fontKerning = "auto";
  textRendering = "auto";
  letterSpacing = "0px";
  imageSmoothingQuality = "low";
  readonly data: Uint8ClampedArray;

  constructor(readonly canvas: FakeOffscreenCanvas) {
    this.data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
  }

  private value(): number {
    return this.fillStyle === "#fff" ? 255 : 0;
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const v = this.value();
    const { width, height } = this.canvas;
    for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(height, Math.ceil(y + h)); yy++) {
      for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(width, Math.ceil(x + w)); xx++) {
        const i = (yy * width + xx) * 4;
        this.data[i] = this.data[i + 1] = this.data[i + 2] = v;
        this.data[i + 3] = 255;
      }
    }
  }

  private advance(families: string[], cp: number): number {
    const f = resolve(families, cp);
    return f ? f.advances.get(cp)! + (fakeOptions.advanceSkew.get(cp) ?? 0) : 0.5;
  }

  measureText(text: string) {
    const { px, families } = parseFont(this.font);
    let w = 0;
    for (const ch of text) w += this.advance(families, ch.codePointAt(0)!) * px;
    const primary = fakeFonts.get(families[0]);
    return {
      width: w,
      fontBoundingBoxAscent: (primary?.ascentEm ?? 0.8) * px,
      fontBoundingBoxDescent: (primary?.descentEm ?? 0.2) * px,
    };
  }

  fillText(text: string, x: number, y: number): void {
    const { px, families } = parseFont(this.font);
    const spacing = parseFloat(this.letterSpacing) || 0;
    let pen = x;
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      const adv = this.advance(families, cp) * px;
      const f = resolve(families, cp);
      const top = y - (f?.ascentEm ?? 0.8) * px;
      const h = ((f?.ascentEm ?? 0.8) + (f?.descentEm ?? 0.2)) * px;
      const ink = f?.ink ? f.ink(cp) : inkFraction(cp);
      this.fillRect(Math.round(pen), Math.round(top), Math.round(adv * ink), Math.round(h));
      pen += adv + spacing;
    }
  }

  drawImage(): void {
    this.fillStyle = "#fff";
    this.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  getImageData(x: number, y: number, w: number, h: number) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let r = 0; r < h; r++) {
      out.set(this.data.subarray(((y + r) * this.canvas.width + x) * 4, ((y + r) * this.canvas.width + x + w) * 4), r * w * 4);
    }
    return { data: out, width: w, height: h };
  }
}

export class FakeOffscreenCanvas {
  private ctx: FakeContext | null = null;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  getContext(kind: string) {
    if (kind !== "2d") return null;
    this.ctx ??= new FakeContext(this);
    return this.ctx;
  }
}

export function installFakeCanvas(): void {
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = FakeOffscreenCanvas;
}
