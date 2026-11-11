// Font priority list with drag and drop reordering.

import { useState } from "react";
import type { LoadedFont } from "../fonts/store";
import { DownIcon, GripIcon, UpIcon, XIcon } from "./icons";
import { asciiOnly, plural } from "./text";

export const DRAG_TYPE = "application/x-unicode-art-font";

/** Final index for an item dragged from `from` and dropped on `over`. */
export function dropIndex(from: number, over: number, after: boolean): number {
  const insert = after ? over + 1 : over;
  return insert > from ? insert - 1 : insert;
}

export function isInternalDrag(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes(DRAG_TYPE);
}

interface Props {
  fonts: readonly LoadedFont[];
  /** Characters each font provides after priority, by family. */
  provided: Map<string, number> | null;
  /** Distinct characters of each font used by the current output, by family. */
  used: Map<string, number> | null;
  onMove(from: number, to: number): void;
  onRemove(id: number): void;
}

function IconButton(props: { label: string; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className="rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {props.children}
    </button>
  );
}

export function FontList({ fonts, provided, used, onMove, onRemove }: Props) {
  const [dragFrom, setDragFrom] = useState(-1);
  const [drop, setDrop] = useState<{ index: number; after: boolean } | null>(null);

  const position = (e: React.DragEvent<HTMLLIElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  };

  if (fonts.length === 0) {
    return <p className="rounded-md border border-dashed border-zinc-800 p-3 text-center text-xs text-zinc-500">No fonts loaded.</p>;
  }

  return (
    <ol
      className="max-h-72 space-y-1 overflow-y-auto overscroll-contain pr-1"
      aria-label="Fonts in priority order"
      data-testid="font-list"
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
      }}
    >
      {fonts.map((f, i) => {
        const p = provided?.get(f.family);
        const u = used?.get(f.family);
        const marker =
          drop?.index === i ? (drop.after ? "border-b-zinc-300" : "border-t-zinc-300") : "border-zinc-800";
        return (
          <li
            key={f.id}
            draggable
            data-testid="font-item"
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, String(i));
              e.dataTransfer.effectAllowed = "move";
              setDragFrom(i);
            }}
            onDragEnd={() => {
              setDragFrom(-1);
              setDrop(null);
            }}
            onDragOver={(e) => {
              if (!isInternalDrag(e.dataTransfer)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const after = position(e);
              if (drop?.index !== i || drop.after !== after) setDrop({ index: i, after });
            }}
            onDrop={(e) => {
              if (!isInternalDrag(e.dataTransfer)) return;
              e.preventDefault();
              e.stopPropagation();
              const from = dragFrom >= 0 ? dragFrom : Number(e.dataTransfer.getData(DRAG_TYPE));
              setDrop(null);
              setDragFrom(-1);
              if (Number.isInteger(from) && from >= 0) onMove(from, dropIndex(from, i, position(e)));
            }}
            className={`flex cursor-grab items-center gap-2 rounded-md border-2 bg-zinc-900 px-2 py-1 active:cursor-grabbing ${marker} ${dragFrom === i ? "opacity-50" : ""}`}
          >
            <span className="text-zinc-600">
              <GripIcon />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-zinc-200" title={asciiOnly(f.name)}>
                {i + 1}. {asciiOnly(f.name)}
              </div>
              <div className="text-xs break-words text-zinc-500">
                {f.formats.join("/").toUpperCase()}
                {f.faces.length > 1 ? `, ${f.faces.length} files` : ""}
                {f.isVariable ? ", variable" : ""}, {plural(f.coverage.length, "char")}
                {p !== undefined ? `, provides ${p.toLocaleString("en-US")}` : ""}
                {u !== undefined ? `, ${u.toLocaleString("en-US")} used` : ""}
              </div>
            </div>
            <IconButton label="Move up" disabled={i === 0} onClick={() => onMove(i, i - 1)}>
              <UpIcon />
            </IconButton>
            <IconButton label="Move down" disabled={i === fonts.length - 1} onClick={() => onMove(i, i + 1)}>
              <DownIcon />
            </IconButton>
            <IconButton label="Remove font" onClick={() => onRemove(f.id)}>
              <XIcon />
            </IconButton>
          </li>
        );
      })}
    </ol>
  );
}
