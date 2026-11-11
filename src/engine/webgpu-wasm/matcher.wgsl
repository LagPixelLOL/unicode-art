// Glyph matcher.
//
// Every invocation handles PER start columns of one row for one width bin
// and finds, for each column, the glyph slot with the minimal squared error
// against the target. Handling several columns per invocation reuses every
// glyph value loaded from memory PER times.
// The constants marked "param" are replaced by the host before compiling;
// the defaults keep this file valid WGSL on its own.

const WG: u32 = 64u; // param: invocations per workgroup
const CELL_H: u32 = 16u; // param: cell height in pixels
const MAX_W: u32 = 24u; // param: widest bin in pixels
const PER: u32 = 4u;
const TILE: u32 = WG * PER;
const SPAN: u32 = TILE + MAX_W - 1u;
const INVALID: f32 = 3.0e38;
const NO_SLOT: u32 = 0xffffffffu;

struct Params {
  width: u32,
  row_start: u32,
  group_start: u32,
  group_end: u32,
  first: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

struct Bin {
  width: u32,
  group_offset: u32,
  group_count: u32,
  data_offset: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> target_px: array<f32>;
@group(0) @binding(2) var<storage, read> glyphs: array<u32>;
@group(0) @binding(3) var<storage, read> norms: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> bins: array<Bin>;
@group(0) @binding(5) var<storage, read_write> best_cost: array<f32>;
@group(0) @binding(6) var<storage, read_write> best_slot: array<u32>;

var<workgroup> tile: array<f32, CELL_H * SPAN>;

struct Best {
  cost: f32,
  slot: u32,
}

// Lanes are compared in slot order with a strict comparison, so ties keep
// the lowest slot.
fn pick(c: vec4<f32>, slot: u32, b: Best) -> Best {
  var r = b;
  if (c.x < r.cost) { r = Best(c.x, slot); }
  if (c.y < r.cost) { r = Best(c.y, slot + 1u); }
  if (c.z < r.cost) { r = Best(c.z, slot + 2u); }
  if (c.w < r.cost) { r = Best(c.w, slot + 3u); }
  return r;
}

@compute @workgroup_size(WG)
fn main(
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
) {
  let width = params.width;
  let row = params.row_start + wid.y;
  let bin_index = wid.z;
  let x0 = wid.x * TILE;
  let row_base = row * CELL_H * width;

  for (var i = lid.x; i < CELL_H * SPAN; i += WG) {
    let y = i / SPAN;
    let x = x0 + i % SPAN;
    var v = 0.0;
    if (x < width) {
      v = target_px[row_base + y * width + x];
    }
    tile[i] = v;
  }
  workgroupBarrier();

  let bin = bins[bin_index];
  let w = bin.width;
  let nbins = arrayLength(&bins);

  // Columns lid.x + k * WG of this tile, k = 0..3.
  var t2 = vec4<f32>(0.0);
  for (var y = 0u; y < CELL_H; y++) {
    let trow = y * SPAN + lid.x;
    for (var x = 0u; x < w; x++) {
      let t = vec4<f32>(tile[trow + x], tile[trow + WG + x], tile[trow + 2u * WG + x], tile[trow + 3u * WG + x]);
      t2 += t * t;
    }
  }

  var best = array<Best, 4>(Best(INVALID, NO_SLOT), Best(INVALID, NO_SLOT), Best(INVALID, NO_SLOT), Best(INVALID, NO_SLOT));
  if (params.first == 0u) {
    for (var k = 0u; k < PER; k++) {
      let pos = x0 + lid.x + k * WG;
      if (pos < width) {
        let o = (row * width + pos) * nbins + bin_index;
        best[k] = Best(best_cost[o], best_slot[o]);
      }
    }
  }

  let g_end = min(params.group_end, bin.group_count);
  for (var g = params.group_start; g < g_end; g++) {
    var p = bin.data_offset + g * w * CELL_H;
    var a0 = vec4<f32>(0.0);
    var a1 = vec4<f32>(0.0);
    var a2 = vec4<f32>(0.0);
    var a3 = vec4<f32>(0.0);
    for (var y = 0u; y < CELL_H; y++) {
      let trow = y * SPAN + lid.x;
      for (var x = 0u; x < w; x++) {
        let gv = unpack4x8unorm(glyphs[p]);
        a0 = fma(gv, vec4<f32>(tile[trow + x]), a0);
        a1 = fma(gv, vec4<f32>(tile[trow + WG + x]), a1);
        a2 = fma(gv, vec4<f32>(tile[trow + 2u * WG + x]), a2);
        a3 = fma(gv, vec4<f32>(tile[trow + 3u * WG + x]), a3);
        p++;
      }
    }
    let n = norms[bin.group_offset + g];
    let slot = (bin.group_offset + g) * 4u;
    best[0] = pick(n - 2.0 * a0 + vec4<f32>(t2.x), slot, best[0]);
    best[1] = pick(n - 2.0 * a1 + vec4<f32>(t2.y), slot, best[1]);
    best[2] = pick(n - 2.0 * a2 + vec4<f32>(t2.z), slot, best[2]);
    best[3] = pick(n - 2.0 * a3 + vec4<f32>(t2.w), slot, best[3]);
  }

  for (var k = 0u; k < PER; k++) {
    let pos = x0 + lid.x + k * WG;
    if (pos < width) {
      let o = (row * width + pos) * nbins + bin_index;
      if (pos + w <= width) {
        best_cost[o] = best[k].cost;
        best_slot[o] = best[k].slot;
      } else {
        best_cost[o] = INVALID;
        best_slot[o] = NO_SLOT;
      }
    }
  }
}
