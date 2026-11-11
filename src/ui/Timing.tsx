import type { ArtResult } from "../art/generate";

export interface TimingRow {
  label: string;
  ms: number | null;
  note?: string;
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

/** Breakdown of a finished conversion; "Other" absorbs scheduling and rendering. */
export function timingRows(result: ArtResult, totalMs: number): TimingRow[] {
  const { ms, cached } = result.stats;
  const steps: TimingRow[] = [
    { label: "Measuring characters", ms: ms.charset, note: cached.charset ? "reused" : undefined },
    { label: "Rasterizing and packing glyphs", ms: ms.glyphs, note: cached.glyphs ? "reused" : undefined },
    { label: "Preparing image (WASM)", ms: ms.target },
    { label: "Matching glyphs (WebGPU)", ms: result.layout.ms.score },
    { label: "Laying out rows (WASM)", ms: result.layout.ms.solve },
  ];
  const known = steps.reduce((s, r) => s + (r.ms ?? 0), 0);
  steps.push({ label: "Other", ms: Math.max(0, totalMs - known) });
  return steps;
}

export function Timing({ result, totalMs, verifyMs }: { result: ArtResult; totalMs: number; verifyMs: number | null }) {
  const rows = timingRows(result, totalMs);
  return (
    <div className="group relative" data-testid="timing">
      <button
        type="button"
        aria-describedby="timing-breakdown"
        className="rounded-md bg-zinc-800 px-2 py-2 text-xs whitespace-nowrap text-zinc-300 hover:bg-zinc-700 focus:outline-none"
      >
        Converted in {formatMs(totalMs)}
      </button>
      <div
        id="timing-breakdown"
        role="tooltip"
        className="invisible absolute top-10 right-0 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-zinc-700 bg-zinc-900 p-3 text-xs text-zinc-300 opacity-0 shadow-xl transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
      >
        <table className="w-full">
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td className="py-0.5 pr-2 text-zinc-400">{r.label}</td>
                <td className="py-0.5 text-right font-mono whitespace-nowrap">
                  {r.ms === null ? "-" : formatMs(r.ms)}
                  {r.note && <span className="text-zinc-500"> ({r.note})</span>}
                </td>
              </tr>
            ))}
            <tr className="border-t border-zinc-700">
              <td className="pt-1 pr-2 font-medium text-zinc-200">Total</td>
              <td className="pt-1 text-right font-mono">{formatMs(totalMs)}</td>
            </tr>
            <tr>
              <td className="py-0.5 pr-2 text-zinc-400">Verification, after conversion</td>
              <td className="py-0.5 text-right font-mono">{verifyMs === null ? "running" : formatMs(verifyMs)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
