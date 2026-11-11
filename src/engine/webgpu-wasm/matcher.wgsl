// Glyph matcher.
//
// One invocation handles one start column of one row for one width bin and
// finds the glyph slot with the minimal squared error against the target.
// The constants marked "param" are replaced by the host before compiling;
// the defaults keep this file valid WGSL on its own.

const TILE: u32 = 64u; // param: start columns per workgroup
const CELL_H: u32 = 16u; // param: cell height in pixels
const MAX_W: u32 = 24u; // param: widest bin in pixels
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

@compute @workgroup_size(TILE)
fn main(
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
) {
  let width = params.width;
  let row = params.row_start + wid.y;
  let bin_index = wid.z;
  let x0 = wid.x * TILE;
  let row_base = row * CELL_H * width;

  for (var i = lid.x; i < CELL_H * SPAN; i += TILE) {
    let y = i / SPAN;
    let x = x0 + i % SPAN;
    var v = 0.0;
    if (x < width) {
      v = target_px[row_base + y * width + x];
    }
    tile[i] = v;
  }
  workgroupBarrier();

  let pos = x0 + lid.x;
  if (pos >= width) {
    return;
  }
  let bin = bins[bin_index];
  let w = bin.width;
  let out_index = (row * width + pos) * arrayLength(&bins) + bin_index;

  var best = INVALID;
  var best_s = NO_SLOT;
  if (params.first == 0u) {
    best = best_cost[out_index];
    best_s = best_slot[out_index];
  }

  if (pos + w <= width) {
    var t2 = 0.0;
    for (var y = 0u; y < CELL_H; y++) {
      for (var x = 0u; x < w; x++) {
        let t = tile[y * SPAN + lid.x + x];
        t2 += t * t;
      }
    }
    let g_end = min(params.group_end, bin.group_count);
    for (var g = params.group_start; g < g_end; g++) {
      var p = bin.data_offset + g * w * CELL_H;
      var acc = vec4<f32>(0.0);
      for (var y = 0u; y < CELL_H; y++) {
        let trow = y * SPAN + lid.x;
        for (var x = 0u; x < w; x++) {
          acc = fma(unpack4x8unorm(glyphs[p]), vec4<f32>(tile[trow + x]), acc);
          p++;
        }
      }
      let c = norms[bin.group_offset + g] - 2.0 * acc + vec4<f32>(t2);
      let slot = (bin.group_offset + g) * 4u;
      if (c.x < best) { best = c.x; best_s = slot; }
      if (c.y < best) { best = c.y; best_s = slot + 1u; }
      if (c.z < best) { best = c.z; best_s = slot + 2u; }
      if (c.w < best) { best = c.w; best_s = slot + 3u; }
    }
  }

  best_cost[out_index] = best;
  best_slot[out_index] = best_s;
}
