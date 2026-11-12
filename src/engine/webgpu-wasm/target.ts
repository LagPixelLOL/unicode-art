// WebGPU side of the ink target preparation (see target.wgsl).

import { type ImageHandle, type TargetRequest, checkImage, checkTargetRequest, throwIfAborted } from "../backend";
import { abortable } from "./matcher";
import { type DeviceLimits, planBlur, planTargetChunks } from "./plan";
import shaderSource from "./target.wgsl?raw";

/** Invocations per side of a workgroup (WG in the shader). */
export const TARGET_WORKGROUP = 8;
/** Invocations per workgroup of the row sums (ROWS_WG in the shader). */
const ROWS_WORKGROUP = 64;
const ENTRY_POINTS = ["mean_rows", "mean_total", "reduce", "blur_x", "blur_y", "resample"] as const;
type EntryPoint = (typeof ENTRY_POINTS)[number];
const PARAM_BYTES = 64;

/** Source pixels on the GPU. The buffer lives until disposed and no longer in use. */
export class GpuImage implements ImageHandle {
  private users = 0;
  private disposed = false;

  constructor(
    private readonly buffer: GPUBuffer,
    readonly width: number,
    readonly height: number,
  ) {}

  acquire(): GPUBuffer {
    if (this.disposed) throw new Error("The image was already released.");
    this.users++;
    return this.buffer;
  }

  release(): void {
    if (--this.users === 0 && this.disposed) this.buffer.destroy();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.users === 0) this.buffer.destroy();
  }
}

export interface TargetTuning {
  /** Bytes of output per resampling chunk (see planTargetChunks). */
  chunkBytes?: number;
}

export class TargetPreparer {
  private pipelines: Promise<Record<EntryPoint, GPUComputePipeline>> | null = null;
  private readonly layout: GPUBindGroupLayout;
  readonly limits: DeviceLimits;

  constructor(
    private readonly device: GPUDevice,
    private readonly tuning: TargetTuning = {},
  ) {
    this.limits = device.limits;
    const storage = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type },
    });
    this.layout = device.createBindGroupLayout({
      label: "target",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: PARAM_BYTES } },
        storage(1, "read-only-storage"),
        storage(2, "storage"),
        storage(3, "storage"),
        storage(4, "storage"),
        storage(5, "storage"),
      ],
    });
  }

  private compile(): Promise<Record<EntryPoint, GPUComputePipeline>> {
    this.pipelines ??= (async () => {
      const { device } = this;
      device.pushErrorScope("validation");
      const module = device.createShaderModule({ label: "target", code: shaderSource });
      const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
      const made = await Promise.all(
        ENTRY_POINTS.map((entryPoint) =>
          device.createComputePipelineAsync({ label: `target ${entryPoint}`, layout, compute: { module, entryPoint } }),
        ),
      );
      const err = await device.popErrorScope();
      if (err) throw new Error(`Image shader failed to compile: ${err.message}`);
      return Object.fromEntries(ENTRY_POINTS.map((e, i) => [e, made[i]])) as Record<EntryPoint, GPUComputePipeline>;
    })();
    this.pipelines.catch(() => (this.pipelines = null));
    return this.pipelines;
  }

  upload(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): GpuImage {
    checkImage(rgba, width, height);
    const bytes = width * height * 4;
    if (bytes > Math.min(this.limits.maxStorageBufferBindingSize, this.limits.maxBufferSize)) {
      throw new Error("The image is too large for the GPU buffer limits.");
    }
    const buffer = this.device.createBuffer({ label: "source pixels", size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buffer, 0, rgba.buffer, rgba.byteOffset, bytes);
    return new GpuImage(buffer, width, height);
  }

  async prepare(req: TargetRequest): Promise<Float32Array> {
    checkTargetRequest(req);
    if (!(req.image instanceof GpuImage)) throw new Error("The image belongs to another backend.");
    throwIfAborted(req.signal);
    const image = req.image;
    const src = image.acquire();
    try {
      return await this.run(req, image, src);
    } finally {
      image.release();
    }
  }

  private async run(req: TargetRequest, image: GpuImage, src: GPUBuffer): Promise<Float32Array> {
    const { signal } = req;
    const r = { width: image.width, height: image.height, outWidth: req.outWidth, outHeight: req.outHeight };
    const { device } = this;
    const pipelines = await abortable(this.compile(), signal);
    const pre = req.preprocessing;
    const contrast = pre.contrast > 0;
    const boost = pre.edgeAmount > 0;
    const blur = boost ? planBlur(pre.edgeSigma) : { step: 1, sigma: 1, radius: 1 };
    const gridW = Math.ceil(r.width / blur.step);
    const gridH = Math.ceil(r.height / blur.step);
    const chunkRows = Math.min(r.outHeight, planTargetChunks(r.outWidth, this.limits, TARGET_WORKGROUP, this.tuning.chunkBytes));
    const chunkBytes = chunkRows * r.outWidth * 4;

    const buffers: GPUBuffer[] = [];
    const buffer = (label: string, size: number, usage: number) => {
      const b = device.createBuffer({ label, size: Math.max(16, size), usage });
      buffers.push(b);
      return b;
    };
    try {
      const params = buffer("target params", PARAM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const gridBytes = boost ? gridW * gridH * 4 : 0;
      const gridA = buffer("blur grid a", gridBytes, GPUBufferUsage.STORAGE);
      const gridB = buffer("blur grid b", gridBytes, GPUBufferUsage.STORAGE);
      const out = buffer("target", chunkBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const read = buffer("target readback", chunkBytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
      const stats = buffer("grey statistics", contrast ? (r.height + 1) * 4 : 0, GPUBufferUsage.STORAGE);
      const bindGroup = device.createBindGroup({
        layout: this.layout,
        entries: [params, src, gridA, gridB, out, stats].map((b, binding) => ({ binding, resource: { buffer: b } })),
      });

      const words = new ArrayBuffer(PARAM_BYTES);
      const u32 = new Uint32Array(words);
      const f32 = new Float32Array(words);
      u32.set([r.width, r.height, r.outWidth, r.outHeight, 0, 0, gridW, gridH, blur.step, blur.radius, pre.invert ? 1 : 0, boost ? 1 : 0]);
      f32.set([pre.contrast, pre.edgeAmount, blur.sigma], 12);

      const result = new Float32Array(r.outWidth * r.outHeight);
      const groups = (n: number) => Math.ceil(n / TARGET_WORKGROUP);
      for (let row = 0; row < r.outHeight; row += chunkRows) {
        throwIfAborted(signal);
        const rows = Math.min(chunkRows, r.outHeight - row);
        u32[4] = row;
        u32[5] = rows;
        device.queue.writeBuffer(params, 0, words);
        const enc = device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setBindGroup(0, bindGroup);
        if (contrast && row === 0) {
          pass.setPipeline(pipelines.mean_rows);
          pass.dispatchWorkgroups(Math.ceil(r.height / ROWS_WORKGROUP));
          pass.setPipeline(pipelines.mean_total);
          pass.dispatchWorkgroups(1);
        }
        if (boost && row === 0) {
          for (const e of ["reduce", "blur_x", "blur_y"] as const) {
            pass.setPipeline(pipelines[e]);
            pass.dispatchWorkgroups(groups(gridW), groups(gridH));
          }
        }
        pass.setPipeline(pipelines.resample);
        pass.dispatchWorkgroups(groups(r.outWidth), groups(rows));
        pass.end();
        const bytes = rows * r.outWidth * 4;
        enc.copyBufferToBuffer(out, 0, read, 0, bytes);
        device.queue.submit([enc.finish()]);
        await abortable(read.mapAsync(GPUMapMode.READ, 0, bytes), signal);
        result.set(new Float32Array(read.getMappedRange(0, bytes)), row * r.outWidth);
        read.unmap();
      }
      return result;
    } finally {
      for (const b of buffers) b.destroy();
    }
  }
}
