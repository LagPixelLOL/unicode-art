// Dismissable notices for errors, warnings and confirmations.

import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { XIcon } from "./icons";
import { asciiOnly } from "./text";

export type Tone = "error" | "warning" | "info";

export interface Notice {
  id: number;
  tone: Tone;
  title: string;
  details?: string[];
}

type Notify = (tone: Tone, title: string, details?: string[]) => void;

const NoticeContext = createContext<Notify>(() => {});

export function useNotify(): Notify {
  return useContext(NoticeContext);
}

export function errorText(e: unknown): string {
  if (e instanceof Error) {
    // Out of memory and panics in the compute core surface as RuntimeErrors.
    if (e.name === "RuntimeError" || e instanceof RangeError) {
      return `${e.message}. The image or font set may be too large for the available memory.`;
    }
    return e.message;
  }
  return String(e);
}

const MAX_DETAILS = 20;
const INFO_TIMEOUT_MS = 6000;

const TONE: Record<Tone, string> = {
  error: "border-red-900 bg-red-950/90 text-red-200",
  warning: "border-amber-900 bg-amber-950/90 text-amber-200",
  info: "border-zinc-700 bg-zinc-900/95 text-zinc-200",
};

function NoticeItem({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (notice.tone !== "info") return;
    const t = setTimeout(onClose, INFO_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [notice.tone, onClose]);
  const details = notice.details ?? [];
  return (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      data-testid="notice"
      data-tone={notice.tone}
      className={`pointer-events-auto rounded-md border px-3 py-2 text-sm shadow-lg ${TONE[notice.tone]}`}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 break-words">{notice.title}</p>
        <button type="button" onClick={onClose} aria-label="Dismiss" className="rounded p-0.5 opacity-70 hover:opacity-100">
          <XIcon />
        </button>
      </div>
      {details.length > 0 && (
        <div className="mt-1">
          <button type="button" className="text-xs underline opacity-80 hover:opacity-100" onClick={() => setOpen(!open)}>
            {open ? "Hide details" : `Show details (${details.length})`}
          </button>
          {open && (
            <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-4 text-xs opacity-90">
              {details.slice(0, MAX_DETAILS).map((d, i) => (
                <li key={i} className="break-all">
                  {d}
                </li>
              ))}
              {details.length > MAX_DETAILS && <li>and {details.length - MAX_DETAILS} more</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const notify = useCallback<Notify>((tone, title, details) => {
    setNotices((list) => {
      const clean = { tone, title: asciiOnly(title), details: details?.map(asciiOnly) };
      // Repeating the same notice only moves it to the front.
      const rest = list.filter((n) => n.title !== clean.title || n.tone !== tone);
      return [...rest, { id: (list.at(-1)?.id ?? 0) + 1, ...clean }].slice(-5);
    });
  }, []);
  const close = useMemo(() => {
    const cache = new Map<number, () => void>();
    return (id: number) => {
      let fn = cache.get(id);
      if (!fn) {
        fn = () => setNotices((list) => list.filter((n) => n.id !== id));
        cache.set(id, fn);
      }
      return fn;
    };
  }, []);
  return (
    <NoticeContext.Provider value={notify}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[calc(100vw-2rem)] flex-col gap-2 sm:w-96" aria-live="polite">
        {notices.map((n) => (
          <NoticeItem key={n.id} notice={n} onClose={close(n.id)} />
        ))}
      </div>
    </NoticeContext.Provider>
  );
}
