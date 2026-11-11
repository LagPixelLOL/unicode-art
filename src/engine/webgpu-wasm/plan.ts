// Pure planning helpers for the WebGPU matcher (no GPU access, unit tested).

export interface ShaderParams {
  WG: number;
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

/** Start columns handled by one invocation (PER in the shader). */
export const COLUMNS_PER_INVOCATION = 4;
export const WORKGROUP_SIZES = [64, 32, 16, 8, 4, 2, 1] as const;

/** Shared memory used by a workgroup of `wg` invocations. */
export function workgroupBytes(wg: number, cellH: number, maxW: number): number {
  return (wg * COLUMNS_PER_INVOCATION + maxW - 1) * cellH * 4;
}

export interface WorkgroupChoice {
  /** Invocations per workgroup. */
  size: number;
  /** Start columns per workgroup. */
  tile: number;
}

/**
 * Largest workgroup whose shared target slice fits the device, but not so
 * large that one workgroup spans more columns than the row has (which
 * would leave most invocations idle), unless nothing smaller fits.
 */
export function chooseWorkgroup(cellH: number, maxW: number, limits: DeviceLimits, width = Infinity): WorkgroupChoice | null {
  const fitting = WORKGROUP_SIZES.filter(
    (size) =>
      size <= limits.maxComputeInvocationsPerWorkgroup &&
      size <= limits.maxComputeWorkgroupSizeX &&
      workgroupBytes(size, cellH, maxW) <= limits.maxComputeWorkgroupStorageSize,
  );
  if (fitting.length === 0) return null;
  const size = fitting.find((s) => s * COLUMNS_PER_INVOCATION <= width || s <= MIN_PREFERRED_WORKGROUP) ?? fitting[0];
  return { size, tile: size * COLUMNS_PER_INVOCATION };
}

/** Smaller workgroups than this waste SIMD lanes on most GPUs. */
export const MIN_PREFERRED_WORKGROUP = 32;

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

/** Fewer glyph groups per dispatch would make the per dispatch setup dominate. */
export const MIN_GROUPS_PER_DISPATCH = 32;

/**
 * Splits one batch into dispatches of bounded work, so work can be submitted
 * in small, cancellable steps. Within a row range, group chunks run in order
 * and the first one initializes the results.
 */
export function planDispatches(
  rows: number,
  width: number,
  cellH: number,
  maxWidth: number,
  binCount: number,
  maxGroupCount: number,
  budget = 2 ** 28,
): Dispatch[] {
  const perRowGroup = Math.max(1, width * 4 * maxWidth * cellH * binCount);
  const groupsTotal = Math.max(1, maxGroupCount);
  const groupsPerChunk = Math.min(groupsTotal, Math.max(MIN_GROUPS_PER_DISPATCH, Math.floor(budget / perRowGroup)));
  const rowsPerChunk = Math.max(1, Math.min(rows, Math.floor(budget / (perRowGroup * groupsPerChunk))));
  const out: Dispatch[] = [];
  for (let r = 0; r < rows; r += rowsPerChunk) {
    const rowCount = Math.min(rowsPerChunk, rows - r);
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

/**
 * Picks how many dispatches go into one submission so each submission takes
 * about `targetMs`: long enough to amortize the round trip, short enough
 * for cancelling to feel immediate.
 */
export class SubmissionSizer {
  private size = 1;
  constructor(
    private readonly targetMs = 30,
    private readonly max = 1024,
  ) {}

  next(): number {
    return this.size;
  }

  record(count: number, ms: number): void {
    if (count <= 0) return;
    const perDispatch = ms / count;
    const ideal = perDispatch > 0 ? this.targetMs / perDispatch : this.size * 2;
    // Grow at most twice as large per step, shrink immediately.
    this.size = Math.max(1, Math.min(this.max, Math.floor(Math.min(ideal, count * 2))));
  }
}
