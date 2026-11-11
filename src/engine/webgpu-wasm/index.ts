import type { BackendFactory, ComputeBackend, ProbeResult } from "../backend";
import { WebGpuWasmBackend } from "./backend";
import { loadCore } from "./core";

// The smallest valid module: magic number and version.
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

export function wasmSupported(): boolean {
  try {
    return typeof WebAssembly === "object" && WebAssembly.validate(EMPTY_WASM);
  } catch {
    return false;
  }
}

async function requestAdapter(gpu: GPU): Promise<GPUAdapter | null> {
  try {
    return await gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch {
    return null;
  }
}

export const webGpuWasmFactory: BackendFactory = {
  id: "webgpu-wasm",
  label: "WebGPU + WebAssembly",

  async probe(): Promise<ProbeResult> {
    const reasons: string[] = [];
    if (!wasmSupported()) reasons.push("WebAssembly is not available in this browser.");
    const gpu = typeof navigator === "object" ? navigator.gpu : undefined;
    if (!gpu) {
      reasons.push("WebGPU is not available in this browser (navigator.gpu is missing).");
    } else if (!(await requestAdapter(gpu))) {
      reasons.push("WebGPU is present, but no GPU adapter could be obtained.");
    }
    return reasons.length ? { ok: false, reasons } : { ok: true };
  },

  async create(): Promise<ComputeBackend> {
    const adapter = await requestAdapter(navigator.gpu);
    if (!adapter) throw new Error("No WebGPU adapter available.");
    const l = adapter.limits;
    const device = await adapter.requestDevice({
      label: "unicode-art",
      requiredLimits: {
        maxStorageBufferBindingSize: l.maxStorageBufferBindingSize,
        maxBufferSize: l.maxBufferSize,
        maxComputeWorkgroupStorageSize: l.maxComputeWorkgroupStorageSize,
        maxComputeInvocationsPerWorkgroup: l.maxComputeInvocationsPerWorkgroup,
        maxComputeWorkgroupSizeX: l.maxComputeWorkgroupSizeX,
      },
    });
    device.addEventListener("uncapturederror", (e) => console.error("WebGPU error:", e.error.message));
    const core = await loadCore();
    return new WebGpuWasmBackend(core, device);
  },
};
