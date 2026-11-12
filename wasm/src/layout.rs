//! Row layout solver.
//!
//! For every row, the matcher provides, at each integer start column and for
//! each width bin, the best glyph and its squared error. The solver then
//! picks the glyph sequence with the minimal total error whose summed
//! advance does not exceed the row width. Glyph advances are fractional;
//! states are keyed by the rounded pen position but keep the exact position,
//! so rounding never accumulates along a row.

/// Costs at or above this value mark invalid candidates.
pub const INVALID_COST: f32 = 1.0e29;

pub struct LayoutInput<'a> {
    pub rows: usize,
    /// Row width in pixels (number of start columns).
    pub width: usize,
    pub bin_count: usize,
    pub cell_h: usize,
    /// `[row][column][bin]` squared error of the best glyph.
    pub costs: &'a [f32],
    /// `[row][column][bin]` slot of the best glyph.
    pub slots: &'a [u32],
    /// Glyph id of every slot.
    pub slot_glyph: &'a [u32],
    /// Exact advance in pixels of every glyph id.
    pub advances: &'a [f32],
    /// Ink target, `rows * cell_h` lines of `width` pixels.
    pub target: &'a [f32],
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Layout {
    /// Glyph ids of all rows, concatenated.
    pub glyphs: Vec<u32>,
    /// Exact pen position (pixels) of every glyph.
    pub positions: Vec<f32>,
    /// `rows + 1` offsets into `glyphs`.
    pub row_offsets: Vec<u32>,
    /// Total advance of every row in pixels.
    pub row_widths: Vec<f32>,
    /// Total squared error including uncovered trailing columns.
    pub total_cost: f64,
}

pub fn solve(input: &LayoutInput<'_>) -> Layout {
    let LayoutInput {
        rows,
        width,
        bin_count,
        cell_h,
        ..
    } = *input;
    assert_eq!(
        input.costs.len(),
        rows * width * bin_count,
        "costs length mismatch"
    );
    assert_eq!(
        input.slots.len(),
        input.costs.len(),
        "slots length mismatch"
    );
    assert_eq!(
        input.target.len(),
        rows * cell_h * width,
        "target length mismatch"
    );

    let mut out = Layout {
        row_offsets: vec![0],
        ..Default::default()
    };
    let limit = width as f64 + 1e-6;

    let mut best = vec![f64::INFINITY; width + 1];
    let mut pen = vec![0f64; width + 1];
    let mut prev = vec![usize::MAX; width + 1];
    let mut glyph = vec![0u32; width + 1];
    let mut tail = vec![0f64; width + 1];

    for r in 0..rows {
        // Error of leaving columns c.. empty.
        tail.iter_mut().for_each(|t| *t = 0.0);
        for y in 0..cell_h {
            let line = &input.target[(r * cell_h + y) * width..(r * cell_h + y + 1) * width];
            for (x, &v) in line.iter().enumerate() {
                tail[x] += (v * v) as f64;
            }
        }
        for x in (0..width).rev() {
            tail[x] += tail[x + 1];
        }

        best.iter_mut().for_each(|b| *b = f64::INFINITY);
        best[0] = 0.0;
        pen[0] = 0.0;
        prev[0] = usize::MAX;

        for c in 0..width {
            if !best[c].is_finite() {
                continue;
            }
            let base = (r * width + c) * bin_count;
            for b in 0..bin_count {
                let cost = input.costs[base + b];
                if !(cost < INVALID_COST) {
                    continue;
                }
                let Some(&g) = input.slot_glyph.get(input.slots[base + b] as usize) else {
                    continue;
                };
                let Some(&adv) = input.advances.get(g as usize) else {
                    continue;
                };
                let next = pen[c] + adv as f64;
                if next > limit {
                    continue;
                }
                let nc = ((next + 0.5).floor() as usize).min(width);
                if nc <= c {
                    continue;
                }
                let total = best[c] + cost.max(0.0) as f64;
                if total < best[nc] {
                    best[nc] = total;
                    pen[nc] = next;
                    prev[nc] = c;
                    glyph[nc] = g;
                }
            }
        }

        let mut end = 0;
        let mut end_cost = f64::INFINITY;
        for c in 0..=width {
            if best[c].is_finite() {
                let total = best[c] + tail[c];
                // On ties prefer the fuller row.
                if total <= end_cost {
                    end_cost = total;
                    end = c;
                }
            }
        }
        out.total_cost += end_cost;

        let start = out.glyphs.len();
        let mut c = end;
        while prev[c] != usize::MAX {
            out.glyphs.push(glyph[c]);
            c = prev[c];
        }
        out.glyphs[start..].reverse();
        let mut x = 0f64;
        for &g in &out.glyphs[start..] {
            out.positions.push(x as f32);
            x += input.advances[g as usize] as f64;
        }
        out.row_widths.push(x as f32);
        out.row_offsets.push(out.glyphs.len() as u32);
    }
    out
}
