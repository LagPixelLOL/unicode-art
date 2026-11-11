import { asciiOnly } from "./text";

export function Unsupported({ failures }: { failures: { label: string; reasons: string[] }[] }) {
  return (
    <div className="flex h-full items-center justify-center p-8" data-state="unsupported">
      <div className="max-w-xl rounded-lg border border-red-900 bg-zinc-900 p-6" role="alert">
        <h1 className="text-lg font-semibold text-red-400">This browser is not supported</h1>
        <p className="mt-2 text-sm text-zinc-300">
          Unicode Art needs both WebGPU and WebAssembly, and has no fallback. Please use a browser with WebGPU
          enabled, such as a current version of Chrome or Edge.
        </p>
        <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-zinc-400" data-testid="unsupported-reasons">
          {failures.flatMap((f) =>
            f.reasons.map((r, i) => <li key={`${f.label}-${i}`}>{asciiOnly(`${f.label}: ${r}`)}</li>),
          )}
        </ul>
      </div>
    </div>
  );
}
