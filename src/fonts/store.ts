// Loaded fonts in priority order. Every entry is registered with the browser
// under a private family name (all of its faces, with their unicode-range),
// so the output can use a plain CSS font stack.

import type { FontRef } from "../art/charset";
import type { ComputeBackend, FontInfoData } from "../engine/backend";
import { type RemoteFont, remoteKey, remoteName } from "./presets";
import type { FontSource } from "./sources";
import { type CodeRange, inRanges, parseUnicodeRange } from "./unicodeRange";

export interface LoadedFace {
  info: FontInfoData;
  face: FontFace;
  ranges: CodeRange[] | null;
  bytes: number;
}

export interface LoadedFont extends FontRef {
  name: string;
  faces: LoadedFace[];
  formats: string[];
  colorGlyphs: number;
  /** Size of the font files as downloaded or uploaded. */
  bytes: number;
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

/**
 * Space characters that browsers (through HarfBuzz) synthesize from the
 * space glyph when a font lacks them, so any font with a space covers them.
 */
export const SYNTHESIZED_SPACES: readonly number[] = [
  0x00a0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f,
  0x3000,
];

function hasCodepoint(sorted: ArrayLike<number>, cp: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] === cp) return true;
    if (sorted[mid] < cp) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

export interface FaceCoverage {
  info: Pick<FontInfoData, "codepoints" | "advances" | "unitsPerEm">;
  ranges: CodeRange[] | null;
}

/**
 * Coverage of a family made of several faces. Like CSS, faces added later
 * are checked first, and a face only serves code points inside its
 * unicode-range that its cmap actually maps. Synthesized spaces get a NaN
 * advance: only the browser knows their width.
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
  for (const cp of SYNTHESIZED_SPACES) {
    if (map.has(cp)) continue;
    for (let f = faces.length - 1; f >= 0; f--) {
      if (inRanges(faces[f].ranges, cp) && hasCodepoint(faces[f].info.codepoints, 0x20)) {
        map.set(cp, Number.NaN);
        break;
      }
    }
  }
  const codepoints = Uint32Array.from(map.keys()).sort();
  const advanceEm = Float32Array.from(codepoints, (cp) => map.get(cp)!);
  return { codepoints, advanceEm };
}

/** The font's own family name for files, when it can be shown as ASCII. */
export function displayName(source: Pick<FontSource, "name" | "preferFamilyName">, family: string): string {
  const f = family.trim();
  return source.preferFamilyName && f && /^[\x20-\x7e]+$/.test(f) ? f : source.name;
}

export interface AddResult {
  font: LoadedFont | null;
  warnings: string[];
}

export type FontStatus = "pending" | "loading" | "ready" | "failed";

/** One row of the priority list. Preset fonts start out pending and are downloaded when first needed. */
export interface FontEntry {
  id: number;
  /** CSS family the font is (or will be) registered under. */
  family: string;
  name: string;
  status: FontStatus;
  /** Where to download the font from, for lazily loaded entries. */
  remote: RemoteFont | null;
  error: string | null;
  font: LoadedFont | null;
}

export type RemoteLoader = (
  fonts: readonly RemoteFont[],
  signal: AbortSignal | undefined,
  onProgress: (done: number, total: number) => void,
) => Promise<{ fonts: FontSource[]; warnings: string[] }>;

/** Byte count with binary units: B, KiB, MiB, GiB, TiB. */
export function formatBytes(n: number): string {
  if (!(n >= 1024)) return `${Math.max(0, Math.round(n || 0))} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export interface ListSize {
  bytes: number;
  loaded: number;
  /** Fonts whose size is unknown until they are downloaded. */
  notDownloaded: number;
  failed: number;
}

export function listSize(entries: readonly FontEntry[]): ListSize {
  const out: ListSize = { bytes: 0, loaded: 0, notDownloaded: 0, failed: 0 };
  for (const e of entries) {
    if (e.status === "ready" && e.font) {
      out.bytes += e.font.bytes;
      out.loaded++;
    } else if (e.status === "failed") out.failed++;
    else out.notDownloaded++;
  }
  return out;
}

export class FontStore {
  private items: FontEntry[] = [];
  private nextId = 1;
  private listeners = new Set<() => void>();

  constructor(
    private readonly backend: ComputeBackend,
    private readonly remote: RemoteLoader,
  ) {}

  get entries(): readonly FontEntry[] {
    return this.items;
  }

  /** Fonts usable for conversion, in priority order. */
  get ready(): LoadedFont[] {
    return this.items.flatMap((e) => (e.status === "ready" && e.font ? [e.font] : []));
  }

  get pendingCount(): number {
    return this.items.filter((e) => e.status === "pending").length;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): readonly FontEntry[] => this.items;

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  private update(id: number, patch: Partial<FontEntry>): void {
    this.items = this.items.map((e) => (e.id === id ? { ...e, ...patch } : e));
    this.changed();
  }

  /** Parses and registers a font under `family`. */
  private async load(source: FontSource, id: number, family: string, signal?: AbortSignal): Promise<AddResult> {
    const warnings: string[] = [];
    const faces: LoadedFace[] = [];
    for (const src of source.faces) {
      signal?.throwIfAborted();
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
      const bytes = info.standalone ?? src.bytes;
      const face = new FontFace(family, bytes.slice().buffer, src.unicodeRange ? { unicodeRange: src.unicodeRange } : {});
      try {
        await face.load();
      } catch {
        warnings.push(`${where}: the browser rejected this font file.`);
        continue;
      }
      faces.push({ info, face, ranges, bytes: src.bytes.byteLength });
    }
    if (faces.length === 0) return { font: null, warnings };

    const { codepoints, advanceEm } = combineFaces(faces);
    const primary = faces.find((f) => inRanges(f.ranges, 0x20)) ?? faces[0];
    const font: LoadedFont = {
      id,
      family,
      name: displayName(source, faces[0].info.family),
      faces,
      coverage: codepoints,
      advanceEm,
      isVariable: faces.some((f) => f.info.isVariable),
      ascentEm: primary.info.ascender / primary.info.unitsPerEm,
      descentEm: -primary.info.descender / primary.info.unitsPerEm,
      formats: [...new Set(faces.map((f) => f.info.format))],
      colorGlyphs: faces.reduce((s, f) => s + f.info.colorGlyphs, 0),
      bytes: faces.reduce((s, f) => s + f.bytes, 0),
    };
    if (codepoints.length === 0) warnings.push(`${font.name}: has no usable characters; it contributes nothing.`);
    if (font.colorGlyphs > 0) {
      warnings.push(`${font.name}: ${font.colorGlyphs} color glyphs are skipped, since the output is monochrome.`);
    }
    for (const f of faces) document.fonts.add(f.face);
    return { font, warnings };
  }

  private unregister(entry: FontEntry): void {
    for (const f of entry.font?.faces ?? []) document.fonts.delete(f.face);
  }

  private allocate(name: string, remote: RemoteFont | null): FontEntry {
    const id = this.nextId++;
    return { id, family: `uaf-${id}`, name, status: "pending", remote, error: null, font: null };
  }

  /** Loads a font right away (files and URLs) and appends it. */
  async add(source: FontSource): Promise<AddResult> {
    const entry = this.allocate(source.name, null);
    const r = await this.load(source, entry.id, entry.family);
    if (r.font) {
      this.items = [...this.items, { ...entry, name: r.font.name, status: "ready", font: r.font }];
      this.changed();
    }
    return r;
  }

  /** Replaces the whole list with fonts that are downloaded when first needed. */
  setRemote(fonts: readonly RemoteFont[]): void {
    for (const e of this.items) this.unregister(e);
    this.items = fonts.map((f) => this.allocate(remoteName(f), f));
    this.changed();
  }

  /**
   * Downloads and registers every pending font. Fonts that fail are marked
   * as failed and reported; on abort, unfinished fonts return to pending.
   */
  ensureReady(signal?: AbortSignal, onProgress?: (phase: string, done: number, total: number) => void): Promise<string[]> {
    // Serialized so a new call never races a cancelled one that is unwinding.
    const run = this.loading.then(() => this.loadPending(signal, onProgress));
    this.loading = run.catch(() => {});
    return run;
  }

  private loading: Promise<unknown> = Promise.resolve();

  private async loadPending(
    signal?: AbortSignal,
    onProgress?: (phase: string, done: number, total: number) => void,
  ): Promise<string[]> {
    signal?.throwIfAborted();
    const pending = this.items.filter((e) => e.status === "pending" && e.remote);
    if (pending.length === 0) return [];
    const ids = new Set(pending.map((e) => e.id));
    this.items = this.items.map((e) => (ids.has(e.id) ? { ...e, status: "loading" as const, error: null } : e));
    this.changed();
    const revert = () => {
      this.items = this.items.map((e) => (ids.has(e.id) && e.status === "loading" ? { ...e, status: "pending" as const } : e));
      this.changed();
    };
    try {
      const report = await this.remote(
        pending.map((e) => e.remote!),
        signal,
        (done, total) => onProgress?.("Downloading fonts", done, total),
      );
      signal?.throwIfAborted();
      const warnings = [...report.warnings];
      const byKey = new Map(report.fonts.map((f) => [f.key ?? f.name, f]));
      for (let i = 0; i < pending.length; i++) {
        signal?.throwIfAborted();
        onProgress?.("Registering fonts", i, pending.length);
        const entry = pending[i];
        if (!this.items.some((e) => e.id === entry.id)) continue; // Removed meanwhile.
        const source = byKey.get(remoteKey(entry.remote!));
        if (!source) {
          this.update(entry.id, { status: "failed", error: "could not be downloaded" });
          continue;
        }
        const r = await this.load(source, entry.id, entry.family, signal);
        warnings.push(...r.warnings);
        if (!this.items.some((e) => e.id === entry.id)) {
          if (r.font) this.unregister({ ...entry, font: r.font });
          continue;
        }
        this.update(entry.id, r.font ? { status: "ready", font: r.font } : { status: "failed", error: "no usable font file" });
      }
      return warnings;
    } finally {
      revert();
    }
  }

  remove(id: number): void {
    const entry = this.items.find((f) => f.id === id);
    if (!entry) return;
    this.unregister(entry);
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
