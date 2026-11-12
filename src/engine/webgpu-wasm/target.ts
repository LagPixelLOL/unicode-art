// WebGPU side of the ink target preparation (see target.wgsl).

import { type ImageHandle, type TargetRequest, checkImage, checkTargetRequest, throwIfAborted } from "../backend";
import { abortable } from "./matcher";
import { type DeviceLimits, planBlur, planTargetChunks, planTiles } from "./plan";
import shaderSource from "./target.wgsl?raw";

/** Invocations per side of a workgroup (WG in the shader). */
export const TARGET_WORKGROUP = 8;
const ENTRY_POINTS = [
  "clahe_tiles",
  "reduce_mean",
  "blur_mean_x",
  "blur_mean_y",
  "reduce_edge",
  "blur_edge_x",
  "blur_edge_y",
  "edge_magnitude",
  "edge_hist",
  "edge_level",
  "resample",
] as const;
/** Histogram bins per tile (BINS in the shader). */
const BINS = 256;
type EntryPoint = (typeof ENTRY_POINTS)[number];
const PARAM_BYTES = 128;
/** Workgroups that histogram the outline map (HIST_GROUPS in the shader). */
const MAX_HIST_GROUPS = 1024;

interface GridPlan {
  w: number;
  h: number;
  step: number;
  sigma: number;
  radius: number;
  /** Offsets of the grid's two buffers in the shared grid buffer, in values. */
  a: number;
  b: number;
}

/** Blur grids for `sigma` (or none) laid out from offset `at`. */
function gridPlan(width: number, height: number, sigma: number | null, at: number): GridPlan {
  const plan = sigma === null ? { step: 1, sigma: 1, radius: 1 } : planBlur(sigma);
  const w = sigma === null ? 0 : Math.ceil(width / plan.step);
  const h = sigma === null ? 0 : Math.ceil(height / plan.step);
  return { ...plan, w, h, a: at, b: at + w * h };
}

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
    const equalize = pre.clipLimit > 1;
    const curve = pre.curve > 0;
    const boost = pre.edges > 0;
    const tiles = equalize ? planTiles(r.width, r.height, pre.tileSize) : { x: 1, y: 1 };
    const mean = gridPlan(r.width, r.height, curve ? pre.curveSigma : null, 0);
    const edge = gridPlan(r.width, r.height, boost ? pre.edgeSigma : null, mean.b + mean.w * mean.h);
    const gridValues = edge.b + edge.w * edge.h;
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
      const grids = buffer("blur grids", gridValues * 4, GPUBufferUsage.STORAGE);
      const out = buffer("target", chunkBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const read = buffer("target readback", chunkBytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
      const luts = buffer("tile lookup tables", equalize ? tiles.x * tiles.y * (BINS + 1) * 4 : 0, GPUBufferUsage.STORAGE);
      const edgeStats = buffer("outline statistics", (BINS + 4 + MAX_HIST_GROUPS) * 4, GPUBufferUsage.STORAGE);
      const bindGroup = device.createBindGroup({
        layout: this.layout,
        entries: [params, src, grids, out, luts, edgeStats].map((b, binding) => ({ binding, resource: { buffer: b } })),
      });

      const words = new ArrayBuffer(PARAM_BYTES);
      const u32 = new Uint32Array(words);
      const f32 = new Float32Array(words);
      const flag = (on: boolean) => (on ? 1 : 0);
      u32.set([r.width, r.height, r.outWidth, r.outHeight, 0, 0, flag(pre.invert), flag(boost), flag(equalize), flag(curve), tiles.x, tiles.y]);
      f32.set([pre.curve, pre.edges, pre.clipLimit, pre.edgeSigma * Math.sqrt(2 * Math.PI)], 12);
      for (const [g, at] of [
        [mean, 16],
        [edge, 24],
      ] as const) {
        u32.set([g.w, g.h, g.step, g.radius, 0, g.a, g.b], at);
        f32[at + 4] = g.sigma;
      }

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
        if (row === 0) {
          if (equalize) {
            pass.setPipeline(pipelines.clahe_tiles);
            pass.dispatchWorkgroups(tiles.x, tiles.y);
          }
          // The local mean first: the edge boost blurs the curved image.
          const blurs: [boolean, GridPlan, readonly EntryPoint[]][] = [
            [curve, mean, ["reduce_mean", "blur_mean_x", "blur_mean_y"]],
            [boost, edge, ["reduce_edge", "blur_edge_x", "blur_edge_y"]],
          ];
          for (const [on, g, entries] of blurs) {
            if (!on) continue;
            for (const e of entries) {
              pass.setPipeline(pipelines[e]);
              pass.dispatchWorkgroups(groups(g.w), groups(g.h));
            }
          }
          if (boost) {
            pass.setPipeline(pipelines.edge_magnitude);
            pass.dispatchWorkgroups(groups(edge.w), groups(edge.h));
            pass.setPipeline(pipelines.edge_hist);
            pass.dispatchWorkgroups(Math.min(Math.ceil((edge.w * edge.h) / BINS), MAX_HIST_GROUPS));
            pass.setPipeline(pipelines.edge_level);
            pass.dispatchWorkgroups(1);
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
