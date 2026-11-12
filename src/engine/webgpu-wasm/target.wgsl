// Ink target preparation.
//
// The source image is composited over white and converted to grey. The
// preprocessing (flip, contrast boost, edge boost) is applied to that grey
// image at the source resolution; the result is resampled in linear light to
// the sampling grid and encoded back to sRGB brightness.
//
// Contrast boosting pivots on the mean grey of the (flipped) image, which
// mean_rows and mean_total compute first.
//
// Edge boosting is an unsharp mask. Its Gaussian blur runs on a grid of
// blocks `step` pixels wide (reduce, blur_x, blur_y) and is sampled
// bilinearly by resample, which computes every grey value on the fly, so no
// full resolution intermediate image is stored.

const WG: u32 = 8u;
const ROWS_WG: u32 = 64u;

struct Params {
  src_w: u32,
  src_h: u32,
  out_w: u32,
  out_h: u32,
  // First output row and number of rows of this chunk.
  row_start: u32,
  rows: u32,
  grid_w: u32,
  grid_h: u32,
  step: u32,
  // Gaussian taps on each side, on the grid.
  radius: u32,
  invert: u32,
  boost: u32,
  // Contrast boost in [0, 1].
  contrast: f32,
  amount: f32,
  // Gaussian sigma on the grid, in blocks.
  sigma: f32,
  pad: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
// Straight alpha RGBA, one pixel per word (red in the low byte).
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> grid_a: array<f32>;
@group(0) @binding(3) var<storage, read_write> grid_b: array<f32>;
@group(0) @binding(4) var<storage, read_write> out_px: array<f32>;
// Mean grey at index 0, then the grey sum of every source row.
@group(0) @binding(5) var<storage, read_write> stats: array<f32>;

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

// S-curve around the mean grey m with slope 1 / (1 - contrast) at m. Black,
// white and m stay where they are; contrast 1 thresholds at m.
fn boost_contrast(v: f32) -> f32 {
  let c = params.contrast;
  let m = stats[0];
  if (c <= 0.0 || m <= 0.0 || m >= 1.0) {
    return v;
  }
  if (c >= 1.0) {
    return select(select(1.0, m, v == m), 0.0, v < m);
  }
  let k = 1.0 / (1.0 - c);
  if (v < m) {
    return m * pow(v / m, k);
  }
  return 1.0 - (1.0 - m) * pow((1.0 - v) / (1.0 - m), k);
}

// Preprocessed grey value of a source pixel, before edge boosting.
fn grey(x: u32, y: u32) -> f32 {
  return boost_contrast(flipped(x, y));
}

@compute @workgroup_size(ROWS_WG)
fn mean_rows(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.src_h) {
    return;
  }
  var sum = 0.0;
  for (var x = 0u; x < params.src_w; x++) {
    sum += flipped(x, id.x);
  }
  stats[id.x + 1u] = sum;
}

@compute @workgroup_size(1)
fn mean_total() {
  var sum = 0.0;
  for (var y = 0u; y < params.src_h; y++) {
    sum += stats[y + 1u];
  }
  stats[0] = sum / f32(params.src_w * params.src_h);
}

// Tent weighted averages of the grey image around every block center, two
// blocks wide. With linear interpolation back to pixels this keeps the blur
// centered on every pixel, which plain block averages would not.
@compute @workgroup_size(WG, WG)
fn reduce(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.grid_w || id.y >= params.grid_h) {
    return;
  }
  let s = f32(params.step);
  let cx = (f32(id.x) + 0.5) * s - 0.5;
  let cy = (f32(id.y) + 0.5) * s - 0.5;
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
      sum += w * grey(x, y);
      total += w;
    }
  }
  grid_a[id.y * params.grid_w + id.x] = sum / total;
}

fn gauss(k: i32) -> f32 {
  let t = f32(k) / params.sigma;
  return exp(-0.5 * t * t);
}

@compute @workgroup_size(WG, WG)
fn blur_x(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.grid_w || id.y >= params.grid_h) {
    return;
  }
  let r = i32(params.radius);
  let last = i32(params.grid_w) - 1;
  let row = id.y * params.grid_w;
  var sum = 0.0;
  var total = 0.0;
  for (var k = -r; k <= r; k++) {
    let w = gauss(k);
    sum += w * grid_a[row + u32(clamp(i32(id.x) + k, 0, last))];
    total += w;
  }
  grid_b[row + id.x] = sum / total;
}

@compute @workgroup_size(WG, WG)
fn blur_y(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.grid_w || id.y >= params.grid_h) {
    return;
  }
  let r = i32(params.radius);
  let last = i32(params.grid_h) - 1;
  var sum = 0.0;
  var total = 0.0;
  for (var k = -r; k <= r; k++) {
    let w = gauss(k);
    sum += w * grid_b[u32(clamp(i32(id.y) + k, 0, last)) * params.grid_w + id.x];
    total += w;
  }
  grid_a[id.y * params.grid_w + id.x] = sum / total;
}

// Fully preprocessed grey value of a source pixel, in linear light.
fn linear_px(x: u32, y: u32) -> f32 {
  var v = grey(x, y);
  if (params.boost != 0u) {
    let s = f32(params.step);
    let u = clamp((f32(x) + 0.5) / s - 0.5, 0.0, f32(params.grid_w - 1u));
    let w = clamp((f32(y) + 0.5) / s - 0.5, 0.0, f32(params.grid_h - 1u));
    let x0 = u32(u);
    let y0 = u32(w);
    let x1 = min(x0 + 1u, params.grid_w - 1u);
    let y1 = min(y0 + 1u, params.grid_h - 1u);
    let g = params.grid_w;
    let top = mix(grid_a[y0 * g + x0], grid_a[y0 * g + x1], u - f32(x0));
    let bottom = mix(grid_a[y1 * g + x0], grid_a[y1 * g + x1], u - f32(x0));
    let blurred = mix(top, bottom, w - f32(y0));
    v = clamp(v + params.amount * (v - blurred), 0.0, 1.0);
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
