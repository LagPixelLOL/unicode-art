use crate::fixture;
use unicode_art_core::font::{FontError, FontFormat, detect_format, parse_font};

#[test]
fn parses_truetype_and_filters_coverage() {
    let f = parse_font(&fixture("sans.ttf")).unwrap();
    assert_eq!(f.format, FontFormat::TrueType);
    assert_eq!(f.family, "Fixture Sans");
    assert_eq!(f.units_per_em, 2048);
    assert!(f.ascender > 0 && f.descender < 0);
    assert!(!f.is_variable);
    assert!(f.glyph_count > 95);
    assert_eq!(f.codepoints.len(), f.advances.len());
    assert!(f.codepoints.windows(2).all(|w| w[0] < w[1]), "sorted and unique");
    for cp in [0x20, 0x41, 0x7E, 0xE9] {
        assert!(f.codepoints.contains(&cp), "U+{cp:04X} missing");
    }
    // Present in the font, but combining, right-to-left or invisible.
    for cp in [0x0301, 0x05D0, 0x200B] {
        assert!(!f.codepoints.contains(&cp), "U+{cp:04X} should be filtered");
    }
    // Not in the font at all.
    assert!(!f.codepoints.contains(&0x4E00));
    let adv = |cp: u32| f.advances[f.codepoints.iter().position(|&c| c == cp).unwrap()];
    assert_eq!(adv(0x20), 569);
    assert!(adv(0x57) > adv(0x69), "W is wider than i in a proportional font");
}

#[test]
fn woff_and_woff2_decode_to_the_same_font() {
    let ttf = parse_font(&fixture("sans.ttf")).unwrap();
    for (name, format) in [("sans.woff", FontFormat::Woff), ("sans.woff2", FontFormat::Woff2)] {
        let f = parse_font(&fixture(name)).unwrap();
        assert_eq!(f.format, format);
        assert_eq!(f.codepoints, ttf.codepoints, "{name}");
        assert_eq!(f.advances, ttf.advances, "{name}");
        assert_eq!((f.ascender, f.descender, f.units_per_em), (ttf.ascender, ttf.descender, ttf.units_per_em));
    }
}

#[test]
fn collections_use_the_first_face() {
    let f = parse_font(&fixture("collection.ttc")).unwrap();
    let mono = parse_font(&fixture("mono.ttf")).unwrap();
    assert_eq!(f.format, FontFormat::Collection);
    assert_eq!(f.family, "Fixture Mono");
    assert_eq!(f.codepoints, mono.codepoints);
    assert!(mono.advances.iter().all(|&a| a == mono.advances[0]), "monospace");
}

#[test]
fn rejects_garbage() {
    assert_eq!(detect_format(b"abc"), None);
    assert_eq!(parse_font(b"not a font").unwrap_err(), FontError::UnknownFormat);
    let ttf = fixture("sans.ttf");
    assert!(matches!(parse_font(&ttf[..12]), Err(FontError::Parse(_))));
    let woff2 = fixture("sans.woff2");
    assert!(matches!(parse_font(&woff2[..64]), Err(FontError::Decode(_))));
    for e in [FontError::UnknownFormat, FontError::Decode("x".into()), FontError::Parse("y".into())] {
        assert!(!e.to_string().is_empty());
    }
    for f in [FontFormat::TrueType, FontFormat::OpenType, FontFormat::Collection, FontFormat::Woff, FontFormat::Woff2] {
        assert!(!f.as_str().is_empty());
    }
}

#[test]
fn color_glyphs_are_excluded() {
    let f = parse_font(&fixture("color.ttf")).unwrap();
    assert_eq!(f.color_glyphs, 2, "the emoji and the heart are bitmaps");
    assert_eq!(f.codepoints, vec![0x20], "only the space remains");
    assert_eq!(parse_font(&fixture("sans.ttf")).unwrap().color_glyphs, 0);
}
