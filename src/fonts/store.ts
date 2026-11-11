// Loaded fonts in priority order. Each font is registered with the browser
// under a private family name so the output can use a CSS font stack.

import type { FontRef } from "../art/charset";
import type { ComputeBackend, FontInfoData } from "../engine/backend";

export interface LoadedFont extends FontRef {
  name: string;
  face: FontFace;
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

export class FontStore {
  private items: LoadedFont[] = [];
  private nextId = 1;
  private listeners = new Set<() => void>();

  constructor(private readonly backend: ComputeBackend) {}

  get fonts(): readonly LoadedFont[] {
    return this.items;
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  async add(name: string, bytes: Uint8Array): Promise<LoadedFont> {
    let info: FontInfoData;
    try {
      info = await this.backend.parseFont(bytes);
    } catch (e) {
      throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const id = this.nextId++;
    const family = `uaf-${id}`;
    const face = new FontFace(family, bytes.slice().buffer);
    try {
      await face.load();
    } catch {
      throw new Error(`${name}: the browser rejected this font.`);
    }
    document.fonts.add(face);
    const font: LoadedFont = { id, family, name, info, face };
    this.items = [...this.items, font];
    this.changed();
    return font;
  }

  remove(id: number): void {
    const font = this.items.find((f) => f.id === id);
    if (!font) return;
    document.fonts.delete(font.face);
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
