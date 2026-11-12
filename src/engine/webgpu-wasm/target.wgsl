// Ink target preparation.
//
// The source image is composited over white and converted to grey. The
// preprocessing (flip, contrast boost, edge boost) is applied to that grey
// image at the source resolution; the result is resampled in linear light to
// the sampling grid and encoded back to sRGB brightness.
//
// Contrast boosting is guided by local contrast. The image is first
// equalized tile by tile, contrast limited (CLAHE): clahe_tiles builds one
// lookup table per tile and every pixel blends the tables of the four
// nearest tiles. Then an S-curve spreads every pixel away from its local
// mean, so dark or bright regions keep their detail instead of being
// crushed by a global curve.
//
// Edge boosting blends the image toward an outline drawing: the gradient
// magnitude of a Gaussian blur (edge_magnitude), divided by its 98th
// percentile over the image (edge_hist, edge_level) and soft thresholded,
// so flat areas fade out and only outlines remain at full strength. The
// drawing takes the image's polarity: dark lines on white when its mean
// grey is above one half, light lines on black otherwise.
//
// Both the local mean and the outline map need a Gaussian blur. Blurs run on
// a grid of blocks `step` pixels wide (reduce_*, blur_*) and are sampled
// bilinearly, and every grey value is computed on the fly, so no full
// resolution intermediate image is stored.

const WG: u32 = 8u;
const BINS: u32 = 256u;
// Share of the outline map below the level that maps to full ink.
const EDGE_PERCENTILE: f32 = 0.98;
// Soft threshold of the normalized outline map: weaker is dropped.
const EDGE_LOW: f32 = 0.1;
const EDGE_HIGH: f32 = 0.6;
// Lowest level, so the noise of a nearly flat image never becomes outlines.
const EDGE_MIN_LEVEL: f32 = 0.05;
// Workgroups of edge_hist, each adding one partial sum of the image.
const HIST_GROUPS: u32 = 1024u;

// A blur grid: two buffers of w * h blocks inside `grids`, at a and b.
struct Grid {
  w: u32,
  h: u32,
  step: u32,
  // Gaussian taps on each side, on the grid.
  radius: u32,
  // Gaussian sigma on the grid, in blocks.
  sigma: f32,
  a: u32,
  b: u32,
  pad: u32,
}

struct Params {
  src_w: u32,
  src_h: u32,
  out_w: u32,
  out_h: u32,
  // First output row and number of rows of this chunk.
  row_start: u32,
  rows: u32,
  invert: u32,
  // Whether to boost edges, equalize and apply the S-curve.
  boost: u32,
  equalize: u32,
  curve_on: u32,
  tiles_x: u32,
  tiles_y: u32,
  // S-curve strength in [0, 1].
  curve: f32,
  // Blend toward the outline map, in [0, 1].
  edges: f32,
  // Highest histogram bin, as a multiple of the mean bin count.
  clip: f32,
  // Makes the gradient of a blurred step edge of height h equal h.
  edge_norm: f32,
  mean_grid: Grid,
  edge_grid: Grid,
}

@group(0) @binding(0) var<uniform> params: Params;
// Straight alpha RGBA, one pixel per word (red in the low byte).
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> grids: array<f32>;
@group(0) @binding(3) var<storage, read_write> out_px: array<f32>;
// BINS + 1 cumulative values per tile, from 0 to 1.
@group(0) @binding(4) var<storage, read_write> luts: array<f32>;

struct EdgeStats {
  hist: array<atomic<u32>, BINS>,
  // The outline map's 98th percentile.
  level: f32,
  // 1 when the image is light (dark lines on white), 0 otherwise.
  light: f32,
  pad0: f32,
  pad1: f32,
  // Sums of the blurred image per edge_hist workgroup.
  partial: array<f32, HIST_GROUPS>,
}

@group(0) @binding(5) var<storage, read_write> edge_stats: EdgeStats;

fn srgb_to_linear(v: f32) -> f32 {
  if (v <= 0.04045) {
    return v / 12.92;
  }
  return pow((v + 0.055) / 1.055, 2.4);
}

fn linear_to_srgb(v0: f32) -> f32 {
  let v = clamp(v0, 0.0, 1.0);
  if (v <= 0.0031308) {
    return v * 12.92;
  }
  return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

// One channel composited over white with 8 bit rounding, in linear light.
fn channel(c: u32, a: u32) -> f32 {
  return srgb_to_linear(f32((c * a + 255u * (255u - a) + 127u) / 255u) / 255.0);
}

// Grey value of a source pixel, flipped when asked to.
fn flipped(x: u32, y: u32) -> f32 {
  let p = src[y * params.src_w + x];
  let a = p >> 24u;
  let lum = 0.2126 * channel(p & 255u, a) + 0.7152 * channel((p >> 8u) & 255u, a) + 0.0722 * channel((p >> 16u) & 255u, a);
  let v = linear_to_srgb(lum);
  return select(v, 1.0 - v, params.invert != 0u);
}

// First pixel of tile i of n tiles over `size` pixels.
fn tile_start(i: u32, n: u32, size: u32) -> u32 {
  return i * size / n;
}

fn lookup(tile: u32, v: f32) -> f32 {
  let pos = clamp(v, 0.0, 1.0) * f32(BINS);
  let b = min(u32(pos), BINS - 1u);
  let base = tile * (BINS + 1u) + b;
  return mix(luts[base], luts[base + 1u], pos - f32(b));
}

// Contrast limited equalization of a grey value at pixel (x, y).
fn equalized(x: u32, y: u32, v: f32) -> f32 {
  if (params.equalize == 0u) {
    return v;
  }
  let tw = f32(params.src_w) / f32(params.tiles_x);
  let th = f32(params.src_h) / f32(params.tiles_y);
  let fx = clamp((f32(x) + 0.5) / tw - 0.5, 0.0, f32(params.tiles_x - 1u));
  let fy = clamp((f32(y) + 0.5) / th - 0.5, 0.0, f32(params.tiles_y - 1u));
  let x0 = u32(fx);
  let y0 = u32(fy);
  let x1 = min(x0 + 1u, params.tiles_x - 1u);
  let y1 = min(y0 + 1u, params.tiles_y - 1u);
  let n = params.tiles_x;
  let top = mix(lookup(y0 * n + x0, v), lookup(y0 * n + x1, v), fx - f32(x0));
  let bottom = mix(lookup(y1 * n + x0, v), lookup(y1 * n + x1, v), fx - f32(x0));
  return mix(top, bottom, fy - f32(y0));
}

// Grey value after flipping and equalizing, before the S-curve.
fn contrast_input(x: u32, y: u32) -> f32 {
  return equalized(x, y, flipped(x, y));
}

// Grid values at `base` (g.a or g.b) at pixel (x, y), interpolated linearly.
fn sample(g: Grid, base: u32, x: u32, y: u32) -> f32 {
  let s = f32(g.step);
  let u = clamp((f32(x) + 0.5) / s - 0.5, 0.0, f32(g.w - 1u));
  let w = clamp((f32(y) + 0.5) / s - 0.5, 0.0, f32(g.h - 1u));
  let x0 = u32(u);
  let y0 = u32(w);
  let x1 = min(x0 + 1u, g.w - 1u);
  let y1 = min(y0 + 1u, g.h - 1u);
  let top = mix(grids[base + y0 * g.w + x0], grids[base + y0 * g.w + x1], u - f32(x0));
  let bottom = mix(grids[base + y1 * g.w + x0], grids[base + y1 * g.w + x1], u - f32(x0));
  return mix(top, bottom, w - f32(y0));
}

// S-curve around m with slope 1 / (1 - curve) at m. Black, white and m stay
// where they are; curve 1 thresholds at m.
fn s_curve(v: f32, m0: f32) -> f32 {
  let c = params.curve;
  let m = clamp(m0, 1e-6, 1.0 - 1e-6);
  if (c >= 1.0) {
    return select(select(1.0, m, v == m), 0.0, v < m);
  }
  let k = 1.0 / (1.0 - c);
  if (v < m) {
    return m * pow(clamp(v / m, 0.0, 1.0), k);
  }
  return 1.0 - (1.0 - m) * pow(clamp((1.0 - v) / (1.0 - m), 0.0, 1.0), k);
}

// Preprocessed grey value of a source pixel, before edge boosting.
fn grey(x: u32, y: u32) -> f32 {
  let v = contrast_input(x, y);
  if (params.curve_on == 0u) {
    return v;
  }
  let g = params.mean_grid;
  return s_curve(v, sample(g, g.a, x, y));
}

var<workgroup> hist: array<atomic<u32>, BINS>;
var<workgroup> scan: array<f32, BINS>;

// One workgroup per tile: histogram, clipping with the excess spread evenly
// over all bins, and the cumulative lookup table.
@compute @workgroup_size(BINS)
fn clahe_tiles(@builtin(workgroup_id) tile_id: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  atomicStore(&hist[li], 0u);
  workgroupBarrier();
  let x0 = tile_start(tile_id.x, params.tiles_x, params.src_w);
  let x1 = tile_start(tile_id.x + 1u, params.tiles_x, params.src_w);
  let y0 = tile_start(tile_id.y, params.tiles_y, params.src_h);
  let y1 = tile_start(tile_id.y + 1u, params.tiles_y, params.src_h);
  let w = x1 - x0;
  let n = w * (y1 - y0);
  for (var k = li; k < n; k += BINS) {
    let v = flipped(x0 + k % w, y0 + k / w);
    atomicAdd(&hist[min(u32(v * f32(BINS)), BINS - 1u)], 1u);
  }
  workgroupBarrier();
  let count = f32(atomicLoad(&hist[li]));
  let cap = params.clip * f32(n) / f32(BINS);
  // Total excess over the cap, by tree reduction.
  scan[li] = max(count - cap, 0.0);
  workgroupBarrier();
  for (var stride = BINS / 2u; stride > 0u; stride >>= 1u) {
    if (li < stride) {
      scan[li] += scan[li + stride];
    }
    workgroupBarrier();
  }
  let excess = scan[0];
  workgroupBarrier();
  // Inclusive prefix sum of the clipped histogram.
  scan[li] = min(count, cap) + excess / f32(BINS);
  workgroupBarrier();
  for (var offset = 1u; offset < BINS; offset <<= 1u) {
    var add = 0.0;
    if (li >= offset) {
      add = scan[li - offset];
    }
    workgroupBarrier();
    scan[li] += add;
    workgroupBarrier();
  }
  let tile = tile_id.y * params.tiles_x + tile_id.x;
  luts[tile * (BINS + 1u) + li + 1u] = scan[li] / f32(n);
  if (li == 0u) {
    luts[tile * (BINS + 1u)] = 0.0;
  }
}

// Tent weighted average of the image around the center of block (bx, by),
// two blocks wide; `mean_source` picks the image before the S-curve (for the
// local mean) or after it (for the edge boost). With linear interpolation
// back to pixels this keeps the blur centered on every pixel.
fn reduce_block(g: Grid, bx: u32, by: u32, mean_source: bool) {
  if (bx >= g.w || by >= g.h) {
    return;
  }
  let s = f32(g.step);
  let cx = (f32(bx) + 0.5) * s - 0.5;
  let cy = (f32(by) + 0.5) * s - 0.5;
  let x0 = u32(max(0, i32(floor(cx - s)) + 1));
  let y0 = u32(max(0, i32(floor(cy - s)) + 1));
  let x1 = min(params.src_w, u32(ceil(cx + s)));
  let y1 = min(params.src_h, u32(ceil(cy + s)));
  var sum = 0.0;
  var total = 0.0;
  for (var y = y0; y < y1; y++) {
    let wy = 1.0 - abs(f32(y) - cy) / s;
    for (var x = x0; x < x1; x++) {
      let w = wy * (1.0 - abs(f32(x) - cx) / s);
      // Not select(): that would evaluate grey(), which reads the mean grid
      // this pass is writing.
      if (mean_source) {
        sum += w * contrast_input(x, y);
      } else {
        sum += w * grey(x, y);
      }
      total += w;
    }
  }
  grids[g.a + by * g.w + bx] = sum / total;
}

fn gauss(g: Grid, k: i32) -> f32 {
  let t = f32(k) / g.sigma;
  return exp(-0.5 * t * t);
}

// One separable Gaussian pass: from a to b along x, or from b to a along y.
fn blur_block(g: Grid, bx: u32, by: u32, along_x: bool) {
  if (bx >= g.w || by >= g.h) {
    return;
  }
  let r = i32(g.radius);
  var sum = 0.0;
  var total = 0.0;
  for (var k = -r; k <= r; k++) {
    let w = gauss(g, k);
    if (along_x) {
      sum += w * grids[g.a + by * g.w + u32(clamp(i32(bx) + k, 0, i32(g.w) - 1))];
    } else {
      sum += w * grids[g.b + u32(clamp(i32(by) + k, 0, i32(g.h) - 1)) * g.w + bx];
    }
    total += w;
  }
  grids[select(g.a, g.b, along_x) + by * g.w + bx] = sum / total;
}

@compute @workgroup_size(WG, WG)
fn reduce_mean(@builtin(global_invocation_id) id: vec3<u32>) {
  reduce_block(params.mean_grid, id.x, id.y, true);
}

@compute @workgroup_size(WG, WG)
fn blur_mean_x(@builtin(global_invocation_id) id: vec3<u32>) {
  blur_block(params.mean_grid, id.x, id.y, true);
}

@compute @workgroup_size(WG, WG)
fn blur_mean_y(@builtin(global_invocation_id) id: vec3<u32>) {
  blur_block(params.mean_grid, id.x, id.y, false);
}

@compute @workgroup_size(WG, WG)
fn reduce_edge(@builtin(global_invocation_id) id: vec3<u32>) {
  reduce_block(params.edge_grid, id.x, id.y, false);
}

@compute @workgroup_size(WG, WG)
fn blur_edge_x(@builtin(global_invocation_id) id: vec3<u32>) {
  blur_block(params.edge_grid, id.x, id.y, true);
}

@compute @workgroup_size(WG, WG)
fn blur_edge_y(@builtin(global_invocation_id) id: vec3<u32>) {
  blur_block(params.edge_grid, id.x, id.y, false);
}

// Gradient magnitude of the blurred image (in a) per block, into b.
@compute @workgroup_size(WG, WG)
fn edge_magnitude(@builtin(global_invocation_id) id: vec3<u32>) {
  let g = params.edge_grid;
  if (id.x >= g.w || id.y >= g.h) {
    return;
  }
  let xl = max(id.x, 1u) - 1u;
  let xr = min(id.x + 1u, g.w - 1u);
  let yl = max(id.y, 1u) - 1u;
  let yr = min(id.y + 1u, g.h - 1u);
  let s = f32(g.step);
  var gx = 0.0;
  if (xr > xl) {
    gx = (grids[g.a + id.y * g.w + xr] - grids[g.a + id.y * g.w + xl]) / (f32(xr - xl) * s);
  }
  var gy = 0.0;
  if (yr > yl) {
    gy = (grids[g.a + yr * g.w + id.x] - grids[g.a + yl * g.w + id.x]) / (f32(yr - yl) * s);
  }
  grids[g.b + id.y * g.w + id.x] = sqrt(gx * gx + gy * gy) * params.edge_norm;
}

// Histogram of the outline map, through one histogram per workgroup, and
// a partial sum of the blurred image per workgroup for its mean.
@compute @workgroup_size(BINS)
fn edge_hist(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_index) li: u32,
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(num_workgroups) groups: vec3<u32>,
) {
  atomicStore(&hist[li], 0u);
  workgroupBarrier();
  let g = params.edge_grid;
  let n = g.w * g.h;
  var sum = 0.0;
  for (var k = gid.x; k < n; k += groups.x * BINS) {
    atomicAdd(&hist[min(u32(grids[g.b + k] * f32(BINS)), BINS - 1u)], 1u);
    sum += grids[g.a + k];
  }
  scan[li] = sum;
  workgroupBarrier();
  atomicAdd(&edge_stats.hist[li], atomicLoad(&hist[li]));
  for (var stride = BINS / 2u; stride > 0u; stride >>= 1u) {
    if (li < stride) {
      scan[li] += scan[li + stride];
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    edge_stats.partial[wid.x] = scan[0];
  }
}

// The upper end of the first bin where the cumulative count reaches the
// percentile, and whether the image is light.
@compute @workgroup_size(BINS)
fn edge_level(@builtin(local_invocation_index) li: u32) {
  let g = params.edge_grid;
  let groups = min((g.w * g.h + BINS - 1u) / BINS, HIST_GROUPS);
  var sum = 0.0;
  for (var k = li; k < groups; k += BINS) {
    sum += edge_stats.partial[k];
  }
  scan[li] = sum;
  workgroupBarrier();
  for (var stride = BINS / 2u; stride > 0u; stride >>= 1u) {
    if (li < stride) {
      scan[li] += scan[li + stride];
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    edge_stats.light = select(0.0, 1.0, scan[0] / f32(g.w * g.h) > 0.5);
  }
  workgroupBarrier();
  scan[li] = f32(atomicLoad(&edge_stats.hist[li]));
  workgroupBarrier();
  for (var offset = 1u; offset < BINS; offset <<= 1u) {
    var add = 0.0;
    if (li >= offset) {
      add = scan[li - offset];
    }
    workgroupBarrier();
    scan[li] += add;
    workgroupBarrier();
  }
  let goal = EDGE_PERCENTILE * scan[BINS - 1u];
  let before = select(0.0, scan[max(li, 1u) - 1u], li > 0u);
  if (scan[li] >= goal && before < goal) {
    edge_stats.level = f32(li + 1u) / f32(BINS);
  }
}

// Fully preprocessed grey value of a source pixel, in linear light.
fn linear_px(x: u32, y: u32) -> f32 {
  var v = grey(x, y);
  if (params.boost != 0u) {
    let g = params.edge_grid;
    let outline = smoothstep(EDGE_LOW, EDGE_HIGH, sample(g, g.b, x, y) / max(edge_stats.level, EDGE_MIN_LEVEL));
    // Lines in the tone opposite to the image's background.
    v = mix(v, mix(outline, 1.0 - outline, edge_stats.light), params.edges);
  }
  return srgb_to_linear(v);
}

// Source pixels and weights of one output sample along one axis: area
// averaging when shrinking, linear interpolation when enlarging.
struct Axis {
  first: u32,
  last: u32,
  lo: f32,
  hi: f32,
  t: f32,
  area: u32,
}

fn axis(o: u32, n: u32, m: u32) -> Axis {
  let scale = f32(n) / f32(m);
  if (n >= m) {
    let lo = f32(o) * scale;
    let hi = min(f32(o + 1u) * scale, f32(n));
    let first = min(u32(floor(lo)), n - 1u);
    let last = max(min(u32(ceil(hi)), n), first + 1u);
    return Axis(first, last, lo, hi, 0.0, 1u);
  }
  let c = clamp((f32(o) + 0.5) * scale - 0.5, 0.0, f32(n - 1u));
  let first = u32(floor(c));
  let t = c - f32(first);
  let last = select(first + 1u, first + 2u, first + 1u < n && t > 0.0);
  return Axis(first, last, 0.0, 0.0, t, 0u);
}

fn weight(a: Axis, i: u32) -> f32 {
  if (a.area != 0u) {
    return max(min(f32(i + 1u), a.hi) - max(f32(i), a.lo), 0.0);
  }
  return select(1.0 - a.t, a.t, i > a.first);
}

@compute @workgroup_size(WG, WG)
fn resample(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.out_w || id.y >= params.rows) {
    return;
  }
  let ax = axis(id.x, params.src_w, params.out_w);
  let ay = axis(params.row_start + id.y, params.src_h, params.out_h);
  var sum = 0.0;
  var total = 0.0;
  for (var y = ay.first; y < ay.last; y++) {
    let wy = weight(ay, y);
    for (var x = ax.first; x < ax.last; x++) {
      let w = wy * weight(ax, x);
      sum += w * linear_px(x, y);
      total += w;
    }
  }
  out_px[id.y * params.out_w + id.x] = linear_to_srgb(sum / total);
}
