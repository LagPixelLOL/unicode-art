import type { ReactNode } from "react";

export const inputClass =
  "rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none";
export const buttonClass =
  "rounded-md bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50";

export function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0">
      {/* Relative so header popovers can span the section width. */}
      <div className="relative mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium text-zinc-300">{title}</h2>
        {extra}
      </div>
      {children}
    </section>
  );
}

export function Progress({ value, label }: { value: number; label?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="h-1.5 overflow-hidden rounded bg-zinc-800" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full bg-zinc-400 transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Badge({ ok }: { ok: boolean | null }) {
  const cls = ok === null ? "bg-zinc-800 text-zinc-400" : ok ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400";
  return <span className={`shrink-0 rounded px-1.5 font-medium ${cls}`}>{ok === null ? "..." : ok ? "PASS" : "FAIL"}</span>;
}
