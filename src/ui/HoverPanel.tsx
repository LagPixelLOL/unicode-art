// A hover / focus popover rendered in a portal on top of the page, so it is
// never clipped by (or widens) the scrolling container its trigger lives in.

import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const GAP = 6;
const MARGIN = 8;
const CLOSE_DELAY_MS = 120;

export interface PanelPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

/** Places a panel under the trigger, clamped to the viewport. */
export function placePanel(
  trigger: { left: number; right: number; top: number; bottom: number },
  viewport: { width: number; height: number },
  preferredWidth: number,
  align: "start" | "end",
): PanelPosition {
  const width = Math.min(preferredWidth, viewport.width - 2 * MARGIN);
  const ideal = align === "start" ? trigger.left : trigger.right - width;
  const left = Math.min(Math.max(MARGIN, ideal), viewport.width - MARGIN - width);
  const below = viewport.height - trigger.bottom - GAP - MARGIN;
  const above = trigger.top - GAP - MARGIN;
  if (below >= 160 || below >= above) {
    return { left, top: trigger.bottom + GAP, width, maxHeight: Math.max(80, below) };
  }
  const maxHeight = Math.max(80, above);
  return { left, top: Math.max(MARGIN, trigger.top - GAP - maxHeight), width, maxHeight };
}

interface Props {
  trigger: ReactNode;
  triggerLabel?: string;
  triggerClassName: string;
  children: ReactNode;
  width: number;
  align?: "start" | "end";
  testId?: string;
}

export function HoverPanel({ trigger, triggerLabel, triggerClassName, children, width, align = "start", testId }: Props) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PanelPosition | null>(null);
  const timer = useRef(0);

  const show = useCallback(() => {
    clearTimeout(timer.current);
    setOpen(true);
  }, []);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, []);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const update = () => {
      const r = button.current!.getBoundingClientRect();
      setPos(placePanel(r, { width: window.innerWidth, height: window.innerHeight }, width, align));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, width, align]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={triggerLabel}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        className={triggerClassName}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            data-testid={testId}
            onMouseEnter={show}
            onMouseLeave={hide}
            style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }}
            className="fixed z-50 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 p-4 text-xs text-zinc-300 shadow-xl"
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
