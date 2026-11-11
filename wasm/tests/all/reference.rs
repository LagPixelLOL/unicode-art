//! Straightforward CPU implementation of the GPU matcher semantics, used as
//! the oracle for solver tests.

use unicode_art_core::bank::{GlyphBank, PAD_GLYPH};

pub const INVALID: f32 = 3.0e38;

pub struct Scores {
    pub costs: Vec<f32>,
    pub slots: Vec<u32>,
}

/// Squared error of `slot` placed at column `s` of row `r`.
pub fn slot_cost(bank: &GlyphBank, target: &[f32], width: usize, r: usize, s: usize, slot: u32, w: u32) -> f32 {
    let h = bank.cell_h as usize;
    let mut sum = 0f32;
    for y in 0..h {
        for x in 0..w as usize {
            let t = target[(r * h + y) * width + s + x];
            let g = bank.coverage(slot, x as u32, y as u32) as f32 / 255.0;
            sum += (g - t) * (g - t);
        }
    }
    sum
}

pub fn score(bank: &GlyphBank, target: &[f32], rows: usize, width: usize) -> Scores {
    let nb = bank.bins.len();
    let mut costs = vec![INVALID; rows * width * nb];
    let mut slots = vec![u32::MAX; rows * width * nb];
    for r in 0..rows {
        for s in 0..width {
            for (bi, bin) in bank.bins.iter().enumerate() {
                if s + bin.width as usize > width {
                    continue;
                }
                let i = (r * width + s) * nb + bi;
                for slot in bin.group_offset * 4..(bin.group_offset + bin.group_count) * 4 {
                    if bank.slot_glyph[slot as usize] == PAD_GLYPH {
                        continue;
                    }
                    let c = slot_cost(bank, target, width, r, s, slot, bin.width);
                    if c < costs[i] {
                        costs[i] = c;
                        slots[i] = slot;
                    }
                }
            }
        }
    }
    Scores { costs, slots }
}
