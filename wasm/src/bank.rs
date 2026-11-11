//! Packs rasterized glyph cells into the layout consumed by the matcher.
//!
//! Glyphs are grouped into bins by their pixel width. Inside a bin, glyphs
//! are packed four at a time ("groups"): for every pixel of the cell one
//! `u32` holds the 8 bit coverage of the four glyphs, so the GPU can unpack
//! a whole group with a single `unpack4x8unorm`.

/// Squared norm used for padding slots so they are never selected.
pub const PAD_NORM: f32 = 1.0e30;
/// Slot to glyph mapping value of padding slots.
pub const PAD_GLYPH: u32 = u32::MAX;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BinInfo {
    pub width: u32,
    /// First group of this bin; slots are `group * 4 + lane`.
    pub group_offset: u32,
    pub group_count: u32,
    /// Offset into `data` in `u32` words.
    pub data_offset: u32,
}

#[derive(Debug, Clone, Default)]
pub struct GlyphBank {
    pub cell_h: u32,
    pub bins: Vec<BinInfo>,
    pub data: Vec<u32>,
    /// Squared coverage norm per slot.
    pub norms: Vec<f32>,
    /// Glyph id per slot, `PAD_GLYPH` for padding.
    pub slot_glyph: Vec<u32>,
}

impl GlyphBank {
    pub fn max_width(&self) -> u32 {
        self.bins.iter().map(|b| b.width).max().unwrap_or(0)
    }

    pub fn max_group_count(&self) -> u32 {
        self.bins.iter().map(|b| b.group_count).max().unwrap_or(0)
    }

    /// Coverage (0..=255) of `slot` at cell pixel `(x, y)`.
    pub fn coverage(&self, slot: u32, x: u32, y: u32) -> u8 {
        let group = slot / 4;
        let lane = slot % 4;
        let bin = self
            .bins
            .iter()
            .find(|b| group >= b.group_offset && group < b.group_offset + b.group_count)
            .expect("slot out of range");
        let px = bin.width * self.cell_h;
        let word = self.data[(bin.data_offset + (group - bin.group_offset) * px + y * bin.width + x) as usize];
        (word >> (lane * 8)) as u8
    }
}

struct Entry {
    glyph: u32,
    width: u32,
    pixels: Vec<u8>,
}

#[derive(Default)]
pub struct GlyphBankBuilder {
    cell_h: u32,
    entries: Vec<Entry>,
}

impl GlyphBankBuilder {
    pub fn new(cell_h: u32) -> Self {
        assert!(cell_h > 0, "cell height must be positive");
        Self { cell_h, entries: Vec::new() }
    }

    /// Extracts glyph cells from an RGBA page (coverage is read from the red
    /// channel). For glyph `i`, the cell is the `widths[i]` x `cell_h`
    /// rectangle whose top left corner is `(xs[i], ys[i])`.
    pub fn add_page(&mut self, rgba: &[u8], page_w: u32, xs: &[u32], ys: &[u32], glyphs: &[u32], widths: &[u32]) {
        assert!(xs.len() == ys.len() && xs.len() == glyphs.len() && xs.len() == widths.len());
        let page_h = rgba.len() as u32 / 4 / page_w.max(1);
        for i in 0..xs.len() {
            let (x0, y0, w) = (xs[i], ys[i], widths[i]);
            assert!(w > 0, "glyph width must be positive");
            assert!(x0 + w <= page_w && y0 + self.cell_h <= page_h, "glyph cell outside of page");
            let mut pixels = Vec::with_capacity((w * self.cell_h) as usize);
            for y in 0..self.cell_h {
                let row = ((y0 + y) * page_w + x0) as usize * 4;
                pixels.extend((0..w as usize).map(|x| rgba[row + x * 4]));
            }
            self.entries.push(Entry { glyph: glyphs[i], width: w, pixels });
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn build(mut self) -> GlyphBank {
        self.entries.sort_by_key(|e| (e.width, e.glyph));
        let mut bank = GlyphBank { cell_h: self.cell_h, ..Default::default() };
        let mut i = 0;
        while i < self.entries.len() {
            let width = self.entries[i].width;
            let mut j = i;
            while j < self.entries.len() && self.entries[j].width == width {
                j += 1;
            }
            let members = &self.entries[i..j];
            let px = (width * self.cell_h) as usize;
            let groups = members.len().div_ceil(4);
            bank.bins.push(BinInfo {
                width,
                group_offset: (bank.norms.len() / 4) as u32,
                group_count: groups as u32,
                data_offset: bank.data.len() as u32,
            });
            for g in 0..groups {
                let lanes: Vec<Option<&Entry>> = (0..4).map(|l| members.get(g * 4 + l)).collect();
                for p in 0..px {
                    let mut word = 0u32;
                    for (l, e) in lanes.iter().enumerate() {
                        if let Some(e) = e {
                            word |= (e.pixels[p] as u32) << (l * 8);
                        }
                    }
                    bank.data.push(word);
                }
                for e in &lanes {
                    match e {
                        Some(e) => {
                            bank.norms.push(e.pixels.iter().map(|&v| (v as f32 / 255.0).powi(2)).sum());
                            bank.slot_glyph.push(e.glyph);
                        }
                        None => {
                            bank.norms.push(PAD_NORM);
                            bank.slot_glyph.push(PAD_GLYPH);
                        }
                    }
                }
            }
            i = j;
        }
        bank
    }
}
