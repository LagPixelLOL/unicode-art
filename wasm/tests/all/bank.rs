use unicode_art_core::bank::{GlyphBankBuilder, PAD_GLYPH, PAD_NORM};

/// Builds an RGBA page where glyph `g` occupies a cell filled with
/// `pattern(g, x, y)`.
pub fn page(cells: &[(u32, u32)], cell_h: u32, pattern: impl Fn(u32, u32, u32) -> u8) -> (Vec<u8>, u32, Vec<u32>) {
    let page_w: u32 = cells.iter().map(|&(_, w)| w + 1).sum();
    let mut rgba = vec![7u8; (page_w * cell_h * 4) as usize];
    let mut xs = Vec::new();
    let mut x0 = 0;
    for &(g, w) in cells {
        xs.push(x0);
        for y in 0..cell_h {
            for x in 0..w {
                let i = ((y * page_w + x0 + x) * 4) as usize;
                rgba[i] = pattern(g, x, y);
                rgba[i + 1] = 99; // Only the red channel carries coverage.
            }
        }
        x0 += w + 1;
    }
    (rgba, page_w, xs)
}

#[test]
fn packs_bins_by_width_with_padding() {
    let cells = [(4, 3), (0, 2), (1, 3), (2, 2), (3, 2), (5, 2), (6, 2)];
    let pattern = |g: u32, x: u32, y: u32| (g * 30 + x * 5 + y) as u8;
    let (rgba, page_w, xs) = page(&cells, 2, pattern);
    let mut b = GlyphBankBuilder::new(2);
    assert!(b.is_empty());
    let glyphs: Vec<u32> = cells.iter().map(|c| c.0).collect();
    let widths: Vec<u32> = cells.iter().map(|c| c.1).collect();
    // Split across two pages to exercise incremental building.
    b.add_page(&rgba, page_w, &xs[..3], &[0; 3], &glyphs[..3], &widths[..3]);
    b.add_page(&rgba, page_w, &xs[3..], &[0; 4], &glyphs[3..], &widths[3..]);
    assert_eq!(b.len(), 7);
    let bank = b.build();

    assert_eq!(bank.bins.len(), 2);
    assert_eq!(bank.max_width(), 3);
    assert_eq!(bank.max_group_count(), 2);
    let (b2, b3) = (bank.bins[0], bank.bins[1]);
    assert_eq!((b2.width, b2.group_offset, b2.group_count, b2.data_offset), (2, 0, 2, 0));
    assert_eq!((b3.width, b3.group_offset, b3.group_count, b3.data_offset), (3, 2, 1, 2 * 2 * 2));
    assert_eq!(bank.data.len(), 2 * 4 + 6);
    assert_eq!(bank.slot_glyph, vec![0, 2, 3, 5, 6, PAD_GLYPH, PAD_GLYPH, PAD_GLYPH, 1, 4, PAD_GLYPH, PAD_GLYPH]);
    assert_eq!(bank.norms.len(), bank.slot_glyph.len());

    for (slot, &g) in bank.slot_glyph.iter().enumerate() {
        let slot = slot as u32;
        if g == PAD_GLYPH {
            assert_eq!(bank.norms[slot as usize], PAD_NORM);
            continue;
        }
        let w = cells.iter().find(|c| c.0 == g).unwrap().1;
        let mut norm = 0f32;
        for y in 0..2 {
            for x in 0..w {
                let v = pattern(g, x, y);
                assert_eq!(bank.coverage(slot, x, y), v, "glyph {g} at {x},{y}");
                norm += (v as f32 / 255.0).powi(2);
            }
        }
        assert!((bank.norms[slot as usize] - norm).abs() < 1e-5);
    }
    // Padding lanes are empty.
    assert_eq!(bank.coverage(5, 0, 0), 0);
}

#[test]
fn empty_builder_builds_empty_bank() {
    let bank = GlyphBankBuilder::new(4).build();
    assert!(bank.bins.is_empty() && bank.data.is_empty());
    assert_eq!(bank.max_width(), 0);
    assert_eq!(bank.cell_h, 4);
}

#[test]
#[should_panic(expected = "outside of page")]
fn rejects_cells_outside_the_page() {
    let mut b = GlyphBankBuilder::new(2);
    b.add_page(&[0; 16], 2, &[1], &[0], &[0], &[2]);
}
