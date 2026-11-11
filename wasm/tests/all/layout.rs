use crate::bank::page;
use crate::reference::{score, slot_cost};
use unicode_art_core::bank::{GlyphBank, GlyphBankBuilder};
use unicode_art_core::layout::{LayoutInput, solve};

const H: u32 = 2;

/// Glyph 0: blank, width 1. Glyph 1: full, width 1. Glyph 2: full, width 2.
/// Glyph 3: left half lit, width 2. Glyph 4: blank, width 3.
fn bank() -> GlyphBank {
    let cells = [(0, 1), (1, 1), (2, 2), (3, 2), (4, 3)];
    let (rgba, page_w, xs) = page(&cells, H, |g, x, _| match g {
        1 | 2 => 255,
        3 if x == 0 => 255,
        _ => 0,
    });
    let mut b = GlyphBankBuilder::new(H);
    let glyphs: Vec<u32> = cells.iter().map(|c| c.0).collect();
    let widths: Vec<u32> = cells.iter().map(|c| c.1).collect();
    b.add_page(&rgba, page_w, &xs, &vec![0; cells.len()], &glyphs, &widths);
    b.build()
}

fn target(rows: usize, width: usize, f: impl Fn(usize, usize) -> f32) -> Vec<f32> {
    let mut t = Vec::new();
    for r in 0..rows {
        for _ in 0..H {
            t.extend((0..width).map(|x| f(r, x)));
        }
    }
    t
}

/// Exhaustive search over every glyph sequence with integer advances.
fn brute_force(bank: &GlyphBank, t: &[f32], width: usize, r: usize, advances: &[f32]) -> f64 {
    let tail = |c: usize| -> f64 {
        (0..H as usize)
            .map(|y| (c..width).map(|x| (t[(r * H as usize + y) * width + x] as f64).powi(2)).sum::<f64>())
            .sum()
    };
    fn go(bank: &GlyphBank, t: &[f32], width: usize, r: usize, adv: &[f32], c: usize, tail: &dyn Fn(usize) -> f64) -> f64 {
        let mut best = tail(c);
        for (slot, &g) in bank.slot_glyph.iter().enumerate() {
            if g == u32::MAX {
                continue;
            }
            let a = adv[g as usize] as usize;
            if c + a > width {
                continue;
            }
            let w = bank.bins.iter().find(|b| (slot as u32 / 4) >= b.group_offset && (slot as u32 / 4) < b.group_offset + b.group_count).unwrap().width;
            let cost = slot_cost(bank, t, width, r, c, slot as u32, w) as f64;
            best = best.min(cost + go(bank, t, width, r, adv, c + a, tail));
        }
        best
    }
    go(bank, t, width, r, advances, 0, &tail)
}

fn run(bank: &GlyphBank, t: &[f32], rows: usize, width: usize, advances: &[f32]) -> unicode_art_core::layout::Layout {
    let s = score(bank, t, rows, width);
    solve(&LayoutInput {
        rows,
        width,
        bin_count: bank.bins.len(),
        cell_h: H as usize,
        costs: &s.costs,
        slots: &s.slots,
        slot_glyph: &bank.slot_glyph,
        advances,
        target: t,
    })
}

#[test]
fn matches_exhaustive_search_with_integer_advances() {
    let bank = bank();
    let advances = [1.0, 1.0, 2.0, 2.0, 3.0];
    let width = 7;
    let patterns: [&dyn Fn(usize, usize) -> f32; 4] = [
        &|_, x| if x % 3 == 0 { 1.0 } else { 0.0 },
        &|_, x| x as f32 / 6.0,
        &|_, x| if x < 4 { 0.9 } else { 0.1 },
        &|r, x| ((x * 7 + r * 3) % 5) as f32 / 4.0,
    ];
    let rows = patterns.len();
    let t = target(rows, width, |r, x| patterns[r](r, x));
    let layout = run(&bank, &t, rows, width, &advances);
    let mut total = 0.0;
    for r in 0..rows {
        let expected = brute_force(&bank, &t, width, r, &advances);
        total += expected;
        let (a, b) = (layout.row_offsets[r] as usize, layout.row_offsets[r + 1] as usize);
        let mut x = 0.0;
        let mut cost = 0.0;
        for i in a..b {
            let g = layout.glyphs[i];
            assert_eq!(layout.positions[i], x);
            let slot = bank.slot_glyph.iter().position(|&s| s == g).unwrap() as u32;
            let w = advances[g as usize] as u32;
            cost += slot_cost(&bank, &t, width, r, x as usize, slot, w) as f64;
            x += advances[g as usize];
        }
        assert_eq!(layout.row_widths[r], x);
        assert!(x <= width as f32);
        let tail: f64 = (0..H as usize)
            .map(|y| (x as usize..width).map(|c| (t[(r * H as usize + y) * width + c] as f64).powi(2)).sum::<f64>())
            .sum();
        assert!((cost + tail - expected).abs() < 1e-4, "row {r}: {} vs {expected}", cost + tail);
    }
    assert!((layout.total_cost - total).abs() < 1e-3);
}

#[test]
fn reproduces_an_exact_pattern() {
    let bank = bank();
    let advances = [1.0, 1.0, 2.0, 2.0, 3.0];
    // lit, dark dark dark, lit lit, half: expect zero error.
    let pattern = [1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0];
    let t = target(1, pattern.len(), |_, x| pattern[x]);
    let layout = run(&bank, &t, 1, pattern.len(), &advances);
    assert!(layout.total_cost < 1e-6, "{}", layout.total_cost);
    assert_eq!(layout.row_widths, vec![8.0]);
}

#[test]
fn fractional_advances_do_not_drift() {
    let bank = bank();
    // Every glyph is 2.4 px wide: rounding each advance would drift.
    let advances = [2.4; 5];
    let width = 12;
    let t = target(1, width, |_, _| 0.0);
    let layout = run(&bank, &t, 1, width, &advances);
    let n = layout.glyphs.len();
    assert_eq!(n, 5, "five glyphs of 2.4 px fill 12 px");
    for (i, &p) in layout.positions.iter().enumerate() {
        assert!((p - 2.4 * i as f32).abs() < 1e-4);
    }
    assert!(layout.row_widths[0] <= width as f32 + 1e-4);
}

#[test]
fn never_exceeds_the_row_width() {
    let bank = bank();
    // Only a 3.5 px glyph would match, but it does not fit twice in 6 px.
    let advances = [3.5; 5];
    let t = target(2, 6, |_, _| 1.0);
    let layout = run(&bank, &t, 2, 6, &advances);
    for r in 0..2 {
        assert!(layout.row_widths[r] <= 6.0);
        assert_eq!(layout.row_offsets[r + 1] - layout.row_offsets[r], 1);
    }
}

#[test]
fn rows_without_fitting_glyphs_stay_empty() {
    let bank = bank();
    let advances = [9.0; 5];
    let t = target(1, 3, |_, _| 0.5);
    let layout = run(&bank, &t, 1, 3, &advances);
    assert!(layout.glyphs.is_empty());
    assert_eq!(layout.row_offsets, vec![0, 0]);
    assert_eq!(layout.row_widths, vec![0.0]);
    assert!((layout.total_cost - 0.25 * 6.0).abs() < 1e-6);
}
