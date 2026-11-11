// WebGPU side of the matcher: glyph bank upload and batched scoring.

import { throwIfAborted } from "../backend";
import shaderSource from "./matcher.wgsl?raw";
import {
  type DeviceLimits,
  chooseTile,
  planBatches,
  planDispatches,
  specializeShader,
} from "./plan";

export interface PackedBank {
  cellH: number;
  maxWidth: number;
  maxGroupCount: number;
  binCount: number;
  /** Four words per bin: width, group offset, group count, data offset. */
  bins: Uint32Array;
  data: Uint32Array;
  norms: Float32Array;
  slotGlyph: Uint32Array;
  duplicates: number;
}

export class GpuBank {
  readonly glyphs: GPUBuffer;
  readonly norms: GPUBuffer;
  readonly bins: GPUBuffer;
  constructor(
    device: GPUDevice,
    readonly packed: PackedBank,
  ) {
    const upload = (data: Uint32Array | Float32Array, label: string) => {
      const buf = device.createBuffer({
        label,
        size: Math.max(16, data.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
      return buf;
    };
    this.glyphs = upload(packed.data, "glyph coverage");
    this.norms = upload(packed.norms, "glyph norms");
    this.bins = upload(packed.bins, "glyph bins");
  }
  dispose(): void {
    this.glyphs.destroy();
    this.norms.destroy();
    this.bins.destroy();
  }
}

export interface ScoreBatch {
  rowStart: number;
  rowCount: number;
  costs: Float32Array;
  slots: Uint32Array;
}

export class Matcher {
  private pipelines = new Map<string, Promise<GPUComputePipeline>>();
  readonly limits: DeviceLimits;

  constructor(private readonly device: GPUDevice) {
    this.limits = device.limits;
  }

  private pipeline(tile: number, cellH: number, maxW: number): Promise<GPUComputePipeline> {
    const key = `${tile}/${cellH}/${maxW}`;
    let p = this.pipelines.get(key);
    if (!p) {
      p = (async () => {
        const code = specializeShader(shaderSource, { TILE: tile, CELL_H: cellH, MAX_W: maxW });
        this.device.pushErrorScope("validation");
        const module = this.device.createShaderModule({ label: "matcher", code });
        const pipeline = await this.device.createComputePipelineAsync({
          label: "matcher",
          layout: "auto",
          compute: { module, entryPoint: "main" },
        });
        const err = await this.device.popErrorScope();
        if (err) throw new Error(`Matcher shader failed to compile: ${err.message}`);
        return pipeline;
      })();
      p.catch(() => this.pipelines.delete(key));
      this.pipelines.set(key, p);
    }
    return p;
  }

  /**
   * Scores all rows, yielding results batch by batch so the caller can solve
   * a batch while memory stays bounded.
   */
  async *score(
    bank: GpuBank,
    target: Float32Array,
    rows: number,
    width: number,
    signal?: AbortSignal,
    onProgress?: (fraction: number) => void,
  ): AsyncGenerator<ScoreBatch> {
    const { device } = this;
    const { cellH, maxWidth, binCount, maxGroupCount } = bank.packed;
    if (target.length !== rows * cellH * width) throw new Error("Target size does not match the grid");
    const tile = chooseTile(cellH, maxWidth, this.limits);
    if (tile === null) throw new Error("Glyph cells are too large for this GPU; lower the detail.");
    const pipeline = await this.pipeline(tile, cellH, maxWidth);
    const batches = planBatches(rows, width, cellH, binCount, this.limits);
    const plans = batches.map((b) => planDispatches(b.rowCount, width, cellH, maxWidth, binCount, maxGroupCount));
    const totalWork = plans.flat().reduce((s, d) => s + d.work, 0) || 1;
    let doneWork = 0;

    const maxRows = Math.max(...batches.map((b) => b.rowCount));
    const targetBuf = device.createBuffer({
      label: "target",
      size: maxRows * cellH * width * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const outBytes = maxRows * width * binCount * 4;
    const costBuf = device.createBuffer({
      label: "best cost",
      size: outBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const slotBuf = device.createBuffer({
      label: "best slot",
      size: outBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readCost = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const readSlot = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const params = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: { buffer: targetBuf } },
        { binding: 2, resource: { buffer: bank.glyphs } },
        { binding: 3, resource: { buffer: bank.norms } },
        { binding: 4, resource: { buffer: bank.bins } },
        { binding: 5, resource: { buffer: costBuf } },
        { binding: 6, resource: { buffer: slotBuf } },
      ],
    });

    try {
      for (let bi = 0; bi < batches.length; bi++) {
        const batch = batches[bi];
        const slice = target.subarray(batch.rowStart * cellH * width, (batch.rowStart + batch.rowCount) * cellH * width);
        device.queue.writeBuffer(targetBuf, 0, slice.buffer, slice.byteOffset, slice.byteLength);
        for (const d of plans[bi]) {
          throwIfAborted(signal);
          device.queue.writeBuffer(
            params,
            0,
            new Uint32Array([width, d.rowStart, d.groupStart, d.groupEnd, d.first ? 1 : 0, 0, 0, 0]),
          );
          const enc = device.createCommandEncoder();
          const pass = enc.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(Math.ceil(width / tile), d.rowCount, binCount);
          pass.end();
          device.queue.submit([enc.finish()]);
          await device.queue.onSubmittedWorkDone();
          doneWork += d.work;
          onProgress?.(doneWork / totalWork);
        }
        const bytes = batch.rowCount * width * binCount * 4;
        const enc = device.createCommandEncoder();
        enc.copyBufferToBuffer(costBuf, 0, readCost, 0, bytes);
        enc.copyBufferToBuffer(slotBuf, 0, readSlot, 0, bytes);
        device.queue.submit([enc.finish()]);
        await Promise.all([readCost.mapAsync(GPUMapMode.READ, 0, bytes), readSlot.mapAsync(GPUMapMode.READ, 0, bytes)]);
        const costs = new Float32Array(readCost.getMappedRange(0, bytes).slice(0));
        const slots = new Uint32Array(readSlot.getMappedRange(0, bytes).slice(0));
        readCost.unmap();
        readSlot.unmap();
        yield { rowStart: batch.rowStart, rowCount: batch.rowCount, costs, slots };
      }
    } finally {
      for (const b of [targetBuf, costBuf, slotBuf, readCost, readSlot, params]) b.destroy();
    }
  }
}
