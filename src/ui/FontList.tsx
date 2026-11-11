// Font priority list with drag and drop reordering.

import { useState } from "react";
import { remoteOrigin } from "../fonts/presets";
import { type FontEntry, formatBytes } from "../fonts/store";
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

function describe(e: FontEntry, provided?: number, used?: number): string {
  switch (e.status) {
    case "pending":
      return `Downloaded from ${e.remote ? remoteOrigin(e.remote) : "the web"} when you press Start`;
    case "loading":
      return "Downloading...";
    case "failed":
      return `Failed: ${e.error ?? "unknown error"}`;
  }
  const f = e.font!;
  return (
    `${f.formats.join("/").toUpperCase()}${f.faces.length > 1 ? `, ${f.faces.length} files` : ""}, ${formatBytes(f.bytes)}` +
    `${f.isVariable ? ", variable" : ""}, ${plural(f.coverage.length, "char")}` +
    (provided !== undefined ? `, provides ${provided.toLocaleString("en-US")}` : "") +
    (used !== undefined ? `, ${used.toLocaleString("en-US")} used` : "")
  );
}

interface Props {
  fonts: readonly FontEntry[];
  /** Characters each font provides after priority, by family. */
  provided: Map<string, number> | null;
  /** Distinct characters of each font used by the current output, by family. */
  used: Map<string, number> | null;
  onMove(from: number, to: number): void;
  onRemove(id: number): void;
  /** Disables editing, e.g. while a conversion uses the fonts. */
  locked?: boolean;
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

export function FontList({ fonts, provided, used, onMove, onRemove, locked = false }: Props) {
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
      className="max-h-72 space-y-1 overflow-x-hidden overflow-y-auto py-1 pr-1"
      aria-label="Fonts in priority order"
      data-testid="font-list"
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
      }}
    >
      {fonts.map((f, i) => {
        const p = provided?.get(f.family);
        const u = used?.get(f.family);
        // Insertion bar in the gap above or below this item, hidden when the
        // drop would not move anything.
        const bar =
          drop?.index === i && (dragFrom < 0 || dropIndex(dragFrom, i, drop.after) !== dragFrom)
            ? drop.after
              ? "bottom"
              : "top"
            : null;
        return (
          <li
            key={f.id}
            draggable={!locked}
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
            data-drop={bar ?? undefined}
            className={`relative flex min-w-0 items-center ${locked ? "" : "cursor-grab active:cursor-grabbing"} gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 ${dragFrom === i ? "opacity-50" : ""}`}
          >
            {bar && (
              <div
                aria-hidden="true"
                data-testid="drop-bar"
                className={`pointer-events-none absolute right-0 left-0 h-0.5 rounded-full bg-white ${bar === "top" ? "-top-[3px]" : "-bottom-[3px]"}`}
              />
            )}
            <span className="text-zinc-600">
              <GripIcon />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-zinc-200" title={asciiOnly(f.name)}>
                {i + 1}. {asciiOnly(f.name)}
              </div>
              <div
                className={`text-xs break-words ${f.status === "failed" ? "text-red-400" : "text-zinc-500"}`}
                data-status={f.status}
              >
                {asciiOnly(describe(f, p, u))}
              </div>
            </div>
            <IconButton label="Move up" disabled={locked || i === 0} onClick={() => onMove(i, i - 1)}>
              <UpIcon />
            </IconButton>
            <IconButton label="Move down" disabled={locked || i === fonts.length - 1} onClick={() => onMove(i, i + 1)}>
              <DownIcon />
            </IconButton>
            <IconButton label="Remove font" disabled={locked} onClick={() => onRemove(f.id)}>
              <XIcon />
            </IconButton>
          </li>
        );
      })}
    </ol>
  );
}
