// Native WebGPU (Dawn) for Node. Resolves to null when no adapter exists, so
// GPU tests can be skipped on machines without any GPU or software driver.

let devicePromise: Promise<GPUDevice | null> | null = null;
// Dawn crashes if its instance is garbage collected while devices live, so
// it is kept reachable for the lifetime of the process.
const keepAlive: unknown[] = [];

export function gpuDevice(): Promise<GPUDevice | null> {
  devicePromise ??= (async () => {
    try {
      const { create, globals } = await import("webgpu");
      Object.assign(globalThis, globals);
      const gpu = create([]);
      keepAlive.push(gpu);
      const adapter = await gpu.requestAdapter();
      if (!adapter) return null;
      return await adapter.requestDevice({
        requiredLimits: {
          maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
          maxBufferSize: adapter.limits.maxBufferSize,
        },
      });
    } catch {
      return null;
    }
  })();
  return devicePromise;
}

export async function requireGpuNotice(): Promise<GPUDevice | null> {
  const d = await gpuDevice();
  if (!d) console.warn("No WebGPU adapter in this environment: GPU tests are skipped.");
  return d;
}
