//! Pixel comparison used to verify native text rendering against the
//! computed result.

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Comparison {
    pub pixels: u64,
    /// Sum of absolute coverage differences (coverage in `[0, 1]`).
    pub abs_diff: f64,
    pub ink_a: f64,
    pub ink_b: f64,
    /// Largest per pixel difference in `[0, 1]`.
    pub max_diff: f64,
    /// Pixels whose difference exceeds `threshold`.
    pub differing: u64,
}

impl Comparison {
    /// 1 when both images carry identical ink, 0 when they share none.
    pub fn similarity(&self) -> f64 {
        let ink = self.ink_a.max(self.ink_b);
        if ink <= 0.0 {
            1.0
        } else {
            (1.0 - self.abs_diff / ink).max(0.0)
        }
    }
}

/// Red channel of an RGBA buffer as coverage, box blurred with `radius`.
fn coverage(rgba: &[u8], width: usize, radius: usize) -> Vec<f32> {
    let src: Vec<f32> = rgba
        .as_chunks::<4>()
        .0
        .iter()
        .map(|p| p[0] as f32 / 255.0)
        .collect();
    if radius == 0 || width == 0 {
        return src;
    }
    let height = src.len() / width;
    let blur = |input: &[f32], stride: usize, step: usize, len: usize, lines: usize| -> Vec<f32> {
        let mut out = vec![0f32; input.len()];
        for l in 0..lines {
            let base = l * stride;
            for i in 0..len {
                let lo = i.saturating_sub(radius);
                let hi = (i + radius).min(len - 1);
                let sum: f32 = (lo..=hi).map(|k| input[base + k * step]).sum();
                out[base + i * step] = sum / (hi - lo + 1) as f32;
            }
        }
        out
    };
    let h = blur(&src, width, 1, width, height);
    blur(&h, 1, width, height, width)
}

/// Compares the red channel of two equally sized RGBA images of `width`
/// pixels per line. With a non-zero `radius` both images are box blurred
/// first, so sub-pixel placement differences of fine textures do not count.
pub fn compare_rgba(a: &[u8], b: &[u8], width: usize, threshold: f64, radius: usize) -> Comparison {
    assert_eq!(a.len(), b.len(), "image size mismatch");
    assert!(
        width > 0 && a.len().is_multiple_of(width * 4),
        "width does not match the image"
    );
    let ca = coverage(a, width, radius);
    let cb = coverage(b, width, radius);
    let mut c = Comparison {
        pixels: ca.len() as u64,
        ..Default::default()
    };
    for (&va, &vb) in ca.iter().zip(&cb) {
        let (va, vb) = (va as f64, vb as f64);
        let d = (va - vb).abs();
        c.abs_diff += d;
        c.ink_a += va;
        c.ink_b += vb;
        if d > c.max_diff {
            c.max_diff = d;
        }
        if d > threshold {
            c.differing += 1;
        }
    }
    c
}
