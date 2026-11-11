import type { BackendFactory, ComputeBackend } from "./backend";
import { webGpuWasmFactory } from "./webgpu-wasm";

// Backends in order of preference. Add new implementations here. There is
// intentionally no fallback: when no backend is supported the app reports
// why and stops.
export const BACKENDS: readonly BackendFactory[] = [webGpuWasmFactory];

export type BackendSelection =
  | { ok: true; backend: ComputeBackend }
  | { ok: false; failures: { label: string; reasons: string[] }[] };

export async function selectBackend(factories: readonly BackendFactory[] = BACKENDS): Promise<BackendSelection> {
  const failures: { label: string; reasons: string[] }[] = [];
  for (const f of factories) {
    const probe = await f.probe();
    if (!probe.ok) {
      failures.push({ label: f.label, reasons: probe.reasons });
      continue;
    }
    try {
      return { ok: true, backend: await f.create() };
    } catch (e) {
      failures.push({ label: f.label, reasons: [e instanceof Error ? e.message : String(e)] });
    }
  }
  return { ok: false, failures };
}
