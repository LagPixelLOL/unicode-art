// Loaded fonts in priority order. Every entry is registered with the browser
// under a private family name (all of its faces, with their unicode-range),
// so the output can use a plain CSS font stack.

import type { FontRef } from "../art/charset";
import type { ComputeBackend, FontInfoData } from "../engine/backend";
import type { FontSource } from "./sources";
import { type CodeRange, inRanges, parseUnicodeRange } from "./unicodeRange";

export interface LoadedFace {
  info: FontInfoData;
  face: FontFace;
  ranges: CodeRange[] | null;
}

export interface LoadedFont extends FontRef {
  name: string;
  faces: LoadedFace[];
  formats: string[];
  colorGlyphs: number;
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

export interface FaceCoverage {
  info: Pick<FontInfoData, "codepoints" | "advances" | "unitsPerEm">;
  ranges: CodeRange[] | null;
}

/**
 * Coverage of a family made of several faces. Like CSS, faces added later
 * are checked first, and a face only serves code points inside its
 * unicode-range that its cmap actually maps.
 */
export function combineFaces(faces: readonly FaceCoverage[]): { codepoints: Uint32Array; advanceEm: Float32Array } {
  const map = new Map<number, number>();
  for (let f = faces.length - 1; f >= 0; f--) {
    const { info, ranges } = faces[f];
    for (let i = 0; i < info.codepoints.length; i++) {
      const cp = info.codepoints[i];
      if (!map.has(cp) && inRanges(ranges, cp)) map.set(cp, info.advances[i] / info.unitsPerEm);
    }
  }
  const codepoints = Uint32Array.from(map.keys()).sort();
  const advanceEm = Float32Array.from(codepoints, (cp) => map.get(cp)!);
  return { codepoints, advanceEm };
}

export interface AddResult {
  font: LoadedFont | null;
  warnings: string[];
}

export class FontStore {
  private items: LoadedFont[] = [];
  private nextId = 1;
  private listeners = new Set<() => void>();

  constructor(private readonly backend: ComputeBackend) {}

  get fonts(): readonly LoadedFont[] {
    return this.items;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): readonly LoadedFont[] => this.items;

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /** Parses and registers a font without adding it to the list. */
  private async load(source: FontSource): Promise<AddResult> {
    const id = this.nextId++;
    const family = `uaf-${id}`;
    const warnings: string[] = [];
    const faces: LoadedFace[] = [];
    for (const src of source.faces) {
      const where = source.faces.length > 1 ? `${source.name} (${src.label})` : source.name;
      let info: FontInfoData;
      try {
        info = await this.backend.parseFont(src.bytes);
      } catch (e) {
        warnings.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      let ranges: CodeRange[] | null = null;
      if (src.unicodeRange) {
        ranges = parseUnicodeRange(src.unicodeRange);
        if (!ranges) {
          warnings.push(`${where}: invalid unicode-range, the face was skipped.`);
          continue;
        }
      }
      const face = new FontFace(family, src.bytes.slice().buffer, src.unicodeRange ? { unicodeRange: src.unicodeRange } : {});
      try {
        await face.load();
      } catch {
        warnings.push(`${where}: the browser rejected this font file.`);
        continue;
      }
      faces.push({ info, face, ranges });
    }
    if (faces.length === 0) return { font: null, warnings };

    const { codepoints, advanceEm } = combineFaces(faces);
    const primary = faces.find((f) => inRanges(f.ranges, 0x20)) ?? faces[0];
    const font: LoadedFont = {
      id,
      family,
      name: (source.preferFamilyName && faces[0].info.family.trim()) || source.name,
      faces,
      coverage: codepoints,
      advanceEm,
      isVariable: faces.some((f) => f.info.isVariable),
      ascentEm: primary.info.ascender / primary.info.unitsPerEm,
      descentEm: -primary.info.descender / primary.info.unitsPerEm,
      formats: [...new Set(faces.map((f) => f.info.format))],
      colorGlyphs: faces.reduce((s, f) => s + f.info.colorGlyphs, 0),
    };
    if (codepoints.length === 0) warnings.push(`${source.name}: has no usable characters; it is listed but contributes nothing.`);
    for (const f of faces) document.fonts.add(f.face);
    return { font, warnings };
  }

  private unregister(font: LoadedFont): void {
    for (const f of font.faces) document.fonts.delete(f.face);
  }

  async add(source: FontSource): Promise<AddResult> {
    const r = await this.load(source);
    if (r.font) {
      this.items = [...this.items, r.font];
      this.changed();
    }
    return r;
  }

  /**
   * Replaces the fonts that were in the list when the call started with
   * `sources`. Fonts added meanwhile stay, after the new ones.
   */
  async replace(
    sources: readonly FontSource[],
    signal?: AbortSignal,
    onProgress?: (done: number, total: number) => void,
  ): Promise<string[]> {
    const previous = new Set(this.items.map((f) => f.id));
    const loaded: LoadedFont[] = [];
    const warnings: string[] = [];
    try {
      for (let i = 0; i < sources.length; i++) {
        signal?.throwIfAborted();
        const r = await this.load(sources[i]);
        warnings.push(...r.warnings);
        if (r.font) loaded.push(r.font);
        onProgress?.(i + 1, sources.length);
      }
      signal?.throwIfAborted();
    } catch (e) {
      for (const f of loaded) this.unregister(f);
      throw e;
    }
    for (const f of this.items) if (previous.has(f.id)) this.unregister(f);
    this.items = [...loaded, ...this.items.filter((f) => !previous.has(f.id))];
    this.changed();
    return warnings;
  }

  remove(id: number): void {
    const font = this.items.find((f) => f.id === id);
    if (!font) return;
    this.unregister(font);
    this.items = this.items.filter((f) => f.id !== id);
    this.changed();
  }

  move(from: number, to: number): void {
    const next = moveItem(this.items, from, to);
    if (next.every((f, i) => f === this.items[i])) return;
    this.items = next;
    this.changed();
  }
}
