// Decoding user images and classifying dropped or pasted files.

import type { SourceImage } from "../art/generate";

const FONT_EXT = /\.(ttf|otf|ttc|otc|woff2?)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?)$/i;

export type FileKind = "image" | "font" | null;

export function classifyFile(file: { name: string; type: string }): FileKind {
  if (file.type.startsWith("font/") || FONT_EXT.test(file.name)) return "font";
  if (file.type.startsWith("image/") || IMAGE_EXT.test(file.name)) return "image";
  return null;
}

/** The last image among pasted clipboard items, if any. */
export function imageFromItems(items: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }>): File | null {
  let found: File | null = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "file" && it.type.startsWith("image/")) found = it.getAsFile() ?? found;
  }
  return found;
}

/** Longest side the decoded image is limited to, to bound memory use. */
export const MAX_IMAGE_SIDE = 4096;

export function limitSize(w: number, h: number, max = MAX_IMAGE_SIDE): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

let nextImageId = 1;

export async function decodeImage(blob: Blob, name: string): Promise<SourceImage> {
  if (blob.size === 0) throw new Error(`${name}: the file is empty.`);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "default" });
  } catch {
    throw new Error(`${name}: this image format could not be decoded.`);
  }
  try {
    if (bitmap.width === 0 || bitmap.height === 0) throw new Error(`${name}: the image has no pixels.`);
    const { width, height } = limitSize(bitmap.width, bitmap.height);
    const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas is not available");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    const limited = width !== bitmap.width || height !== bitmap.height;
    return { id: nextImageId++, name, width, height, limited, rgba: data };
  } finally {
    bitmap.close();
  }
}
