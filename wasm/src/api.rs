//! wasm-bindgen surface. Kept thin: validation and data marshalling only.

use crate::{bank, charset, compare, font, layout};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = FontInfo)]
pub struct FontInfo(font::ParsedFont);

#[wasm_bindgen(js_class = FontInfo)]
impl FontInfo {
    #[wasm_bindgen(getter)]
    pub fn format(&self) -> String {
        self.0.format.as_str().to_string()
    }
    #[wasm_bindgen(getter)]
    pub fn family(&self) -> String {
        self.0.family.clone()
    }
    #[wasm_bindgen(getter, js_name = unitsPerEm)]
    pub fn units_per_em(&self) -> u16 {
        self.0.units_per_em
    }
    #[wasm_bindgen(getter)]
    pub fn ascender(&self) -> i16 {
        self.0.ascender
    }
    #[wasm_bindgen(getter)]
    pub fn descender(&self) -> i16 {
        self.0.descender
    }
    #[wasm_bindgen(getter, js_name = lineGap)]
    pub fn line_gap(&self) -> i16 {
        self.0.line_gap
    }
    #[wasm_bindgen(getter, js_name = glyphCount)]
    pub fn glyph_count(&self) -> u16 {
        self.0.glyph_count
    }
    #[wasm_bindgen(getter, js_name = isVariable)]
    pub fn is_variable(&self) -> bool {
        self.0.is_variable
    }
    #[wasm_bindgen(getter, js_name = colorGlyphs)]
    pub fn color_glyphs(&self) -> u32 {
        self.0.color_glyphs
    }
    pub fn codepoints(&self) -> Vec<u32> {
        self.0.codepoints.clone()
    }
    pub fn advances(&self) -> Vec<u16> {
        self.0.advances.clone()
    }
    /// Bytes to hand to the browser when they differ from the input
    /// (collections are reduced to their first face); empty otherwise.
    pub fn standalone(&self) -> Vec<u8> {
        self.0.standalone.clone().unwrap_or_default()
    }
}

#[wasm_bindgen(js_name = parseFont)]
pub fn parse_font(data: &[u8]) -> Result<FontInfo, JsError> {
    font::parse_font(data).map(FontInfo).map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen(js_name = exclusionRules)]
pub fn exclusion_rules() -> String {
    charset::exclusion_rules()
}

#[wasm_bindgen(js_name = isUsable)]
pub fn is_usable(cp: u32) -> bool {
    charset::is_usable(cp)
}

/// Merged coverage: `codepoints[i]` is rendered by font `fontIndex[i]`.
#[wasm_bindgen(js_name = Charset)]
pub struct Charset(charset::MergedCharset);

#[wasm_bindgen(js_class = Charset)]
impl Charset {
    pub fn codepoints(&self) -> Vec<u32> {
        self.0.codepoints.clone()
    }
    #[wasm_bindgen(js_name = fontIndex)]
    pub fn font_index(&self) -> Vec<u32> {
        self.0.font_index.clone()
    }
}

/// `all` holds the coverage lists of every font back to back, `lengths[i]`
/// the length of the list of font `i` (font 0 has the highest priority).
#[wasm_bindgen(js_name = mergeCoverage)]
pub fn merge_coverage(all: &[u32], lengths: &[u32]) -> Result<Charset, JsError> {
    let total: usize = lengths.iter().map(|&l| l as usize).sum();
    if total != all.len() {
        return Err(JsError::new("coverage lengths do not add up"));
    }
    let mut lists = Vec::with_capacity(lengths.len());
    let mut at = 0;
    for &l in lengths {
        lists.push(&all[at..at + l as usize]);
        at += l as usize;
    }
    Ok(Charset(charset::merge_coverage(&lists)))
}

#[wasm_bindgen(js_name = GlyphBankBuilder)]
pub struct GlyphBankBuilder(bank::GlyphBankBuilder);

#[wasm_bindgen(js_class = GlyphBankBuilder)]
impl GlyphBankBuilder {
    #[wasm_bindgen(constructor)]
    pub fn new(cell_h: u32) -> Result<GlyphBankBuilder, JsError> {
        if cell_h == 0 {
            return Err(JsError::new("cell height must be positive"));
        }
        Ok(Self(bank::GlyphBankBuilder::new(cell_h)))
    }

    #[wasm_bindgen(js_name = addPage)]
    pub fn add_page(
        &mut self,
        rgba: &[u8],
        page_w: u32,
        xs: &[u32],
        ys: &[u32],
        glyphs: &[u32],
        widths: &[u32],
    ) -> Result<(), JsError> {
        if xs.len() != ys.len() || xs.len() != glyphs.len() || xs.len() != widths.len() {
            return Err(JsError::new("glyph cell arrays differ in length"));
        }
        if page_w == 0 || rgba.len() % (page_w as usize * 4) != 0 {
            return Err(JsError::new("page buffer does not match page width"));
        }
        let page_h = (rgba.len() / (page_w as usize * 4)) as u64;
        let cell_h = self.0.cell_h() as u64;
        for i in 0..xs.len() {
            let (x, y, w) = (xs[i] as u64, ys[i] as u64, widths[i] as u64);
            if w == 0 || x + w > page_w as u64 || y + cell_h > page_h {
                return Err(JsError::new("glyph cell lies outside of the page"));
            }
        }
        self.0.add_page(rgba, page_w, xs, ys, glyphs, widths);
        Ok(())
    }

    pub fn build(self) -> GlyphBank {
        GlyphBank(self.0.build())
    }
}

#[wasm_bindgen(js_name = GlyphBank)]
pub struct GlyphBank(bank::GlyphBank);

#[wasm_bindgen(js_class = GlyphBank)]
impl GlyphBank {
    #[wasm_bindgen(getter, js_name = cellH)]
    pub fn cell_h(&self) -> u32 {
        self.0.cell_h
    }
    #[wasm_bindgen(getter, js_name = maxWidth)]
    pub fn max_width(&self) -> u32 {
        self.0.max_width()
    }
    #[wasm_bindgen(getter, js_name = maxGroupCount)]
    pub fn max_group_count(&self) -> u32 {
        self.0.max_group_count()
    }
    #[wasm_bindgen(getter)]
    pub fn duplicates(&self) -> u32 {
        self.0.duplicates
    }
    #[wasm_bindgen(getter, js_name = binCount)]
    pub fn bin_count(&self) -> u32 {
        self.0.bins.len() as u32
    }
    /// Four words per bin: width, group offset, group count, data offset.
    pub fn bins(&self) -> Vec<u32> {
        self.0
            .bins
            .iter()
            .flat_map(|b| [b.width, b.group_offset, b.group_count, b.data_offset])
            .collect()
    }
    pub fn data(&self) -> Vec<u32> {
        self.0.data.clone()
    }
    pub fn norms(&self) -> Vec<f32> {
        self.0.norms.clone()
    }
    #[wasm_bindgen(js_name = slotGlyph)]
    pub fn slot_glyph(&self) -> Vec<u32> {
        self.0.slot_glyph.clone()
    }
}

#[wasm_bindgen(js_name = Layout)]
pub struct Layout(layout::Layout);

#[wasm_bindgen(js_class = Layout)]
impl Layout {
    pub fn glyphs(&self) -> Vec<u32> {
        self.0.glyphs.clone()
    }
    pub fn positions(&self) -> Vec<f32> {
        self.0.positions.clone()
    }
    #[wasm_bindgen(js_name = rowOffsets)]
    pub fn row_offsets(&self) -> Vec<u32> {
        self.0.row_offsets.clone()
    }
    #[wasm_bindgen(js_name = rowWidths)]
    pub fn row_widths(&self) -> Vec<f32> {
        self.0.row_widths.clone()
    }
    #[wasm_bindgen(getter, js_name = totalCost)]
    pub fn total_cost(&self) -> f64 {
        self.0.total_cost
    }
}

#[wasm_bindgen(js_name = solveLayout)]
#[allow(clippy::too_many_arguments)]
pub fn solve_layout(
    rows: u32,
    width: u32,
    bin_count: u32,
    cell_h: u32,
    costs: &[f32],
    slots: &[u32],
    slot_glyph: &[u32],
    advances: &[f32],
    target: &[f32],
) -> Result<Layout, JsError> {
    let (r, w, b, h) = (rows as usize, width as usize, bin_count as usize, cell_h as usize);
    if costs.len() != r * w * b || slots.len() != costs.len() {
        return Err(JsError::new("cost buffers do not match the grid"));
    }
    if target.len() != r * h * w {
        return Err(JsError::new("target does not match the grid"));
    }
    if slots.iter().any(|&s| s as usize >= slot_glyph.len() && s != u32::MAX) {
        return Err(JsError::new("slot index out of range"));
    }
    if slot_glyph.iter().any(|&g| g != bank::PAD_GLYPH && g as usize >= advances.len()) {
        return Err(JsError::new("glyph id out of range"));
    }
    let input = layout::LayoutInput {
        rows: r,
        width: w,
        bin_count: b,
        cell_h: h,
        costs,
        slots,
        slot_glyph,
        advances,
        target,
    };
    Ok(Layout(layout::solve(&input)))
}

/// Returns `[pixels, absDiff, inkA, inkB, maxDiff, differing, similarity]`.
#[wasm_bindgen(js_name = compareRgba)]
pub fn compare_rgba(a: &[u8], b: &[u8], width: u32, threshold: f64, radius: u32) -> Result<Vec<f64>, JsError> {
    if a.len() != b.len() {
        return Err(JsError::new("images differ in size"));
    }
    if width == 0 || a.len() % (width as usize * 4) != 0 {
        return Err(JsError::new("image width does not match the pixel buffer"));
    }
    let c = compare::compare_rgba(a, b, width as usize, threshold, radius as usize);
    Ok(vec![
        c.pixels as f64,
        c.abs_diff,
        c.ink_a,
        c.ink_b,
        c.max_diff,
        c.differing as f64,
        c.similarity(),
    ])
}
