// Native glyph rasterization into atlas pages.

import type { GlyphPage } from "../engine/backend";

export interface AtlasSlot {
  page: number;
  /** Top left corner of the cropped cell. */
  x: number;
  y: number;
}

export interface AtlasPlan {
  pageW: number;
  pageH: number;
  margin: number;
  pages: number;
  slots: AtlasSlot[];
}

/**
 * Shelf packs cells of `widths[i] x cellH`, each surrounded by `margin`
 * pixels so ink that overhangs a cell never lands in a neighbouring cell.
 */
export function planAtlas(widths: ArrayLike<number>, cellH: number, margin: number, maxPage = 2048): AtlasPlan {
  const strideH = cellH + 2 * margin;
  const widest = Math.max(0, ...Array.from(widths)) + 2 * margin;
  const pageW = Math.max(maxPage, widest);
  const pageH = Math.max(maxPage, strideH);
  const slots: AtlasSlot[] = [];
  let page = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < widths.length; i++) {
    const stride = widths[i] + 2 * margin;
    if (x + stride > pageW) {
      x = 0;
      y += strideH;
    }
    if (y + strideH > pageH) {
      page++;
      x = 0;
      y = 0;
    }
    slots.push({ page, x: x + margin, y: y + margin });
    x += stride;
  }
  return { pageW, pageH, margin, pages: widths.length ? page + 1 : 0, slots };
}

export interface RasterRequest {
  /** Code point per glyph id. */
  codepoints: ArrayLike<number>;
  /** CSS family name per glyph id. */
  families: ArrayLike<string>;
  widths: ArrayLike<number>;
  fontPx: number;
  cellH: number;
  baselinePx: number;
}

export function cssFont(px: number, families: string | string[]): string {
  const list = (Array.isArray(families) ? families : [families]).map((f) => `"${f}"`).join(", ");
  return `${px}px ${list}`;
}

/**
 * Canvas text settings matching the output CSS: unhinted outlines and exact
 * (unrounded) advances, no kerning.
 */
export function textContext(w: number, h: number): OffscreenCanvasRenderingContext2D {
  const ctx = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas is not available");
  ctx.fontKerning = "none";
  ctx.textRendering = "geometricPrecision";
  ctx.textBaseline = "alphabetic";
  return ctx;
}

/** Draws every glyph with its own font, white on black, page by page. */
export async function* rasterizeGlyphs(req: RasterRequest): AsyncGenerator<GlyphPage> {
  const margin = Math.ceil(req.fontPx / 2);
  const plan = planAtlas(req.widths, req.cellH, margin);
  const ctx = textContext(plan.pageW, plan.pageH);
  let i = 0;
  for (let page = 0; page < plan.pages; page++) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, plan.pageW, plan.pageH);
    ctx.fillStyle = "#fff";
    let font = "";
    const ids: number[] = [];
    for (; i < plan.slots.length && plan.slots[i].page === page; i++) {
      const f = cssFont(req.fontPx, req.families[i]);
      if (f !== font) ctx.font = font = f;
      const s = plan.slots[i];
      ctx.fillText(String.fromCodePoint(req.codepoints[i]), s.x, s.y + req.baselinePx);
      ids.push(i);
    }
    const img = ctx.getImageData(0, 0, plan.pageW, plan.pageH);
    yield {
      rgba: img.data,
      width: plan.pageW,
      xs: Uint32Array.from(ids, (g) => plan.slots[g].x),
      ys: Uint32Array.from(ids, (g) => plan.slots[g].y),
      glyphs: Uint32Array.from(ids),
      widths: Uint32Array.from(ids, (g) => req.widths[g]),
    };
  }
}
