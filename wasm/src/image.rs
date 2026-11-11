//! Source image preparation: alpha over white, greyscale, resampling.

fn srgb_to_linear(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb(v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

/// Per output sample: first source index and normalized weights.
struct Taps {
    start: Vec<usize>,
    weights: Vec<Vec<f32>>,
}

/// Area averaging when shrinking, linear interpolation when enlarging.
fn taps(src: usize, dst: usize) -> Taps {
    let scale = src as f64 / dst as f64;
    let mut start = Vec::with_capacity(dst);
    let mut weights = Vec::with_capacity(dst);
    for o in 0..dst {
        if scale >= 1.0 {
            let a = o as f64 * scale;
            let b = ((o + 1) as f64 * scale).min(src as f64);
            let first = a.floor() as usize;
            let last = (b.ceil() as usize).min(src).max(first + 1);
            let mut w = Vec::with_capacity(last - first);
            for i in first..last {
                let lo = (i as f64).max(a);
                let hi = ((i + 1) as f64).min(b);
                w.push((hi - lo).max(0.0) as f32);
            }
            let sum: f32 = w.iter().sum();
            w.iter_mut().for_each(|x| *x /= sum);
            start.push(first);
            weights.push(w);
        } else {
            let c = ((o as f64 + 0.5) * scale - 0.5).clamp(0.0, (src - 1) as f64);
            let i0 = c.floor() as usize;
            let t = (c - i0 as f64) as f32;
            if i0 + 1 < src && t > 0.0 {
                start.push(i0);
                weights.push(vec![1.0 - t, t]);
            } else {
                start.push(i0);
                weights.push(vec![1.0]);
            }
        }
    }
    Taps { start, weights }
}

/// Converts straight alpha RGBA pixels into an ink target.
///
/// Transparent areas are composited over white, the result is converted to
/// luminance, resampled in linear light to `out_w` x `out_h` and re-encoded
/// to sRGB. The returned value is the desired ink coverage in `[0, 1]`:
/// brightness by default, or darkness when `invert` is set.
pub fn prepare_target(
    rgba: &[u8],
    width: usize,
    height: usize,
    out_w: usize,
    out_h: usize,
    invert: bool,
) -> Vec<f32> {
    assert_eq!(rgba.len(), width * height * 4, "rgba length mismatch");
    assert!(width > 0 && height > 0 && out_w > 0 && out_h > 0, "empty image");

    let lut: Vec<f32> = (0..256).map(|i| srgb_to_linear(i as f32 / 255.0)).collect();
    let mut lum = vec![0f32; width * height];
    for (px, out) in rgba.chunks_exact(4).zip(lum.iter_mut()) {
        let a = px[3] as u32;
        let over = |c: u8| -> f32 { lut[((c as u32 * a + 255 * (255 - a) + 127) / 255) as usize] };
        *out = 0.2126 * over(px[0]) + 0.7152 * over(px[1]) + 0.0722 * over(px[2]);
    }

    let tx = taps(width, out_w);
    let mut horiz = vec![0f32; out_w * height];
    for y in 0..height {
        let row = &lum[y * width..(y + 1) * width];
        let dst = &mut horiz[y * out_w..(y + 1) * out_w];
        for (o, d) in dst.iter_mut().enumerate() {
            let s = tx.start[o];
            *d = tx.weights[o].iter().enumerate().map(|(k, w)| w * row[s + k]).sum();
        }
    }

    let ty = taps(height, out_h);
    let mut out = vec![0f32; out_w * out_h];
    for o in 0..out_h {
        let s = ty.start[o];
        let dst = &mut out[o * out_w..(o + 1) * out_w];
        for (k, &w) in ty.weights[o].iter().enumerate() {
            let src = &horiz[(s + k) * out_w..(s + k + 1) * out_w];
            for (d, v) in dst.iter_mut().zip(src) {
                *d += w * v;
            }
        }
    }
    for v in out.iter_mut() {
        let e = linear_to_srgb(*v);
        *v = if invert { 1.0 - e } else { e };
    }
    out
}
