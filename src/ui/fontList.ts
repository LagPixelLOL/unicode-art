// Font priority list with drag and drop reordering.

import type { FontStore } from "../fonts/store";
import { asciiOnly, plural } from "./text";

const DRAG_TYPE = "application/x-unicode-art-font";

/** Final index for an item dragged from `from` and dropped on `over`. */
export function dropIndex(from: number, over: number, after: boolean): number {
  const insert = after ? over + 1 : over;
  return insert > from ? insert - 1 : insert;
}

export function isInternalDrag(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes(DRAG_TYPE);
}

const ICONS = {
  grip: '<path d="M7 4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm0 6a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-1.5 7.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM16 4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-1.5 7.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM16 16a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z"/>',
  up: '<path fill-rule="evenodd" d="M10 4a.75.75 0 0 1 .53.22l5 5a.75.75 0 1 1-1.06 1.06L10.75 6.56V15.5a.75.75 0 0 1-1.5 0V6.56L5.53 10.28a.75.75 0 0 1-1.06-1.06l5-5A.75.75 0 0 1 10 4Z" clip-rule="evenodd"/>',
  down: '<path fill-rule="evenodd" d="M10 16a.75.75 0 0 1-.53-.22l-5-5a.75.75 0 1 1 1.06-1.06l3.72 3.72V4.5a.75.75 0 0 1 1.5 0v8.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-5 5A.75.75 0 0 1 10 16Z" clip-rule="evenodd"/>',
  remove: '<path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"/>',
};

function icon(name: keyof typeof ICONS): string {
  return `<svg viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4" aria-hidden="true">${ICONS[name]}</svg>`;
}

function button(name: "up" | "down" | "remove", label: string, disabled: boolean): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.innerHTML = icon(name);
  b.ariaLabel = label;
  b.title = label;
  b.dataset.action = name;
  b.disabled = disabled;
  b.className = "rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-30 disabled:hover:bg-transparent";
  return b;
}

export class FontListView {
  private dragFrom = -1;
  /** Characters each font ends up providing, keyed by font id. */
  contributions = new Map<number, number>();

  constructor(
    private readonly el: HTMLOListElement,
    private readonly store: FontStore,
  ) {
    el.addEventListener("click", (e) => {
      const btn = (e.target as Element).closest<HTMLButtonElement>("button[data-action]");
      const li = btn?.closest<HTMLLIElement>("li[data-index]");
      if (!btn || !li) return;
      const i = Number(li.dataset.index);
      if (btn.dataset.action === "up") store.move(i, i - 1);
      else if (btn.dataset.action === "down") store.move(i, i + 1);
      else store.remove(store.fonts[i].id);
    });
    el.addEventListener("dragstart", (e) => {
      const li = (e.target as Element).closest<HTMLLIElement>("li[data-index]");
      if (!li || !e.dataTransfer) return;
      this.dragFrom = Number(li.dataset.index);
      e.dataTransfer.setData(DRAG_TYPE, String(this.dragFrom));
      e.dataTransfer.effectAllowed = "move";
      li.classList.add("opacity-50");
    });
    el.addEventListener("dragend", () => {
      this.dragFrom = -1;
      this.render();
    });
    el.addEventListener("dragover", (e) => {
      if (!isInternalDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      const li = (e.target as Element).closest<HTMLLIElement>("li[data-index]");
      this.markDrop(li, e.clientY);
    });
    el.addEventListener("dragleave", (e) => {
      if (!el.contains(e.relatedTarget as Node | null)) this.markDrop(null, 0);
    });
    el.addEventListener("drop", (e) => {
      if (!isInternalDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      const li = (e.target as Element).closest<HTMLLIElement>("li[data-index]");
      const from = this.dragFrom;
      this.markDrop(null, 0);
      if (!li || from < 0) return;
      const rect = li.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      store.move(from, dropIndex(from, Number(li.dataset.index), after));
    });
  }

  private markDrop(target: HTMLLIElement | null, y: number): void {
    for (const li of this.el.querySelectorAll<HTMLLIElement>("li[data-index]")) {
      li.classList.remove("border-t-zinc-300", "border-b-zinc-300");
      if (li !== target) continue;
      const rect = li.getBoundingClientRect();
      li.classList.add(y > rect.top + rect.height / 2 ? "border-b-zinc-300" : "border-t-zinc-300");
    }
  }

  render(): void {
    const fonts = this.store.fonts;
    this.el.replaceChildren(
      ...fonts.map((f, i) => {
        const li = document.createElement("li");
        li.draggable = true;
        li.dataset.index = String(i);
        li.dataset.testid = "font-item";
        li.className =
          "flex cursor-grab items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 active:cursor-grabbing";
        const grip = document.createElement("span");
        grip.className = "text-zinc-600";
        grip.innerHTML = icon("grip");
        const body = document.createElement("div");
        body.className = "min-w-0 flex-1";
        const name = document.createElement("div");
        name.className = "truncate text-sm text-zinc-200";
        name.textContent = `${i + 1}. ${asciiOnly(f.info.family || f.name)}`;
        name.title = asciiOnly(f.name);
        const meta = document.createElement("div");
        meta.className = "truncate text-xs text-zinc-500";
        const used = this.contributions.get(f.id);
        meta.textContent =
          `${f.info.format.toUpperCase()}${f.info.isVariable ? " variable" : ""}, ${plural(f.info.codepoints.length, "char")}` +
          (used === undefined ? "" : `, ${used.toLocaleString("en-US")} used`);
        body.append(name, meta);
        li.append(
          grip,
          body,
          button("up", "Move up", i === 0),
          button("down", "Move down", i === fonts.length - 1),
          button("remove", "Remove font", false),
        );
        return li;
      }),
    );
  }
}
