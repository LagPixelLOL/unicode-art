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
        if ink <= 0.0 { 1.0 } else { (1.0 - self.abs_diff / ink).max(0.0) }
    }
}

/// Compares the red channel of two equally sized RGBA buffers.
pub fn compare_rgba(a: &[u8], b: &[u8], threshold: f64) -> Comparison {
    assert_eq!(a.len(), b.len(), "image size mismatch");
    let mut c = Comparison { pixels: (a.len() / 4) as u64, ..Default::default() };
    for (pa, pb) in a.chunks_exact(4).zip(b.chunks_exact(4)) {
        let va = pa[0] as f64 / 255.0;
        let vb = pb[0] as f64 / 255.0;
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
