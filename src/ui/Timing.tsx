import type { ArtResult } from "../art/generate";
import { HoverPanel } from "./HoverPanel";

export interface TimingRow {
  label: string;
  ms: number | null;
  note?: string;
}

export function formatMs(ms: number): string {
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
    <HoverPanel
      trigger={`Converted in ${formatMs(totalMs)}`}
      triggerClassName="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700 focus:outline-none"
      width={320}
      align="start"
      testId="timing-breakdown"
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
    </HoverPanel>
  );
}
