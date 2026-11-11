// Pure planning helpers for the WebGPU matcher (no GPU access, unit tested).

export interface ShaderParams {
  TILE: number;
  CELL_H: number;
  MAX_W: number;
}

/** Replaces the `// param` constants of the WGSL source. */
export function specializeShader(src: string, params: ShaderParams): string {
  let out = src;
  for (const [name, value] of Object.entries(params)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid shader parameter ${name}=${value}`);
    const re = new RegExp(`^const ${name}: u32 = \\d+u; // param`, "m");
    if (!re.test(out)) throw new Error(`Shader parameter ${name} not found`);
    out = out.replace(re, `const ${name}: u32 = ${value}u; // param`);
  }
  return out;
}

export interface DeviceLimits {
  maxComputeWorkgroupStorageSize: number;
  maxComputeInvocationsPerWorkgroup: number;
  maxComputeWorkgroupSizeX: number;
  maxComputeWorkgroupsPerDimension: number;
  maxStorageBufferBindingSize: number;
  maxBufferSize: number;
}

export const TILE_SIZES = [64, 32, 16, 8, 4, 2, 1] as const;

export function workgroupBytes(tile: number, cellH: number, maxW: number): number {
  return (tile + maxW - 1) * cellH * 4;
}

/** Largest workgroup tile whose shared target slice fits the device. */
export function chooseTile(cellH: number, maxW: number, limits: DeviceLimits): number | null {
  for (const tile of TILE_SIZES) {
    if (tile > limits.maxComputeInvocationsPerWorkgroup || tile > limits.maxComputeWorkgroupSizeX) continue;
    if (workgroupBytes(tile, cellH, maxW) <= limits.maxComputeWorkgroupStorageSize) return tile;
  }
  return null;
}

export interface Batch {
  rowStart: number;
  rowCount: number;
}

/** Splits rows so the per batch target and result buffers stay within limits. */
export function planBatches(
  rows: number,
  width: number,
  cellH: number,
  binCount: number,
  limits: DeviceLimits,
  budgetBytes = 64 * 1024 * 1024,
): Batch[] {
  const cap = Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize, budgetBytes);
  const perRow = Math.max(cellH * width * 4, width * binCount * 4);
  const maxRows = Math.min(Math.floor(cap / perRow), limits.maxComputeWorkgroupsPerDimension);
  if (maxRows < 1) throw new Error("The output is too wide for the GPU buffer limits; reduce the width.");
  const out: Batch[] = [];
  for (let r = 0; r < rows; r += maxRows) out.push({ rowStart: r, rowCount: Math.min(maxRows, rows - r) });
  return out;
}

export interface Dispatch {
  rowStart: number;
  rowCount: number;
  groupStart: number;
  groupEnd: number;
  first: boolean;
  /** Estimated multiply-adds, for progress reporting. */
  work: number;
}

/**
 * Splits one batch into dispatches of bounded work so a single submission
 * never runs long enough to trip GPU watchdogs. Within a row range, group
 * chunks run in order and the first one initializes the results.
 */
export function planDispatches(
  rows: number,
  width: number,
  cellH: number,
  maxWidth: number,
  binCount: number,
  maxGroupCount: number,
  budget = 2 ** 30,
): Dispatch[] {
  const perRowGroup = Math.max(1, width * 4 * maxWidth * cellH * binCount);
  const groupsPerChunk = Math.max(1, Math.min(maxGroupCount, Math.floor(budget / perRowGroup)));
  const rowsPerChunk = Math.max(1, Math.min(rows, Math.floor(budget / (perRowGroup * groupsPerChunk))));
  const out: Dispatch[] = [];
  for (let r = 0; r < rows; r += rowsPerChunk) {
    const rowCount = Math.min(rowsPerChunk, rows - r);
    const groupsTotal = Math.max(1, maxGroupCount);
    for (let g = 0; g < groupsTotal; g += groupsPerChunk) {
      const groupEnd = Math.min(groupsTotal, g + groupsPerChunk);
      out.push({
        rowStart: r,
        rowCount,
        groupStart: g,
        groupEnd,
        first: g === 0,
        work: rowCount * (groupEnd - g) * perRowGroup,
      });
    }
  }
  return out;
}
