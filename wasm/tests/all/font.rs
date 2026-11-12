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
    assert!(
        f.codepoints.windows(2).all(|w| w[0] < w[1]),
        "sorted and unique"
    );
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
    assert!(
        adv(0x57) > adv(0x69),
        "W is wider than i in a proportional font"
    );
}

#[test]
fn woff_and_woff2_decode_to_the_same_font() {
    let ttf = parse_font(&fixture("sans.ttf")).unwrap();
    for (name, format) in [
        ("sans.woff", FontFormat::Woff),
        ("sans.woff2", FontFormat::Woff2),
    ] {
        let f = parse_font(&fixture(name)).unwrap();
        assert_eq!(f.format, format);
        assert_eq!(f.codepoints, ttf.codepoints, "{name}");
        assert_eq!(f.advances, ttf.advances, "{name}");
        assert_eq!(
            (f.ascender, f.descender, f.units_per_em),
            (ttf.ascender, ttf.descender, ttf.units_per_em)
        );
    }
}

#[test]
fn collections_use_the_first_face() {
    let f = parse_font(&fixture("collection.ttc")).unwrap();
    let mono = parse_font(&fixture("mono.ttf")).unwrap();
    assert_eq!(f.format, FontFormat::Collection);
    assert_eq!(f.family, "Fixture Mono");
    assert_eq!(f.codepoints, mono.codepoints);
    assert!(
        mono.advances.iter().all(|&a| a == mono.advances[0]),
        "monospace"
    );
    // The extracted face parses to the same font and is self contained.
    let standalone = f.standalone.expect("collections are extracted");
    assert_eq!(&standalone[0..4], &[0, 1, 0, 0]);
    let again = parse_font(&standalone).unwrap();
    assert_eq!(again.format, FontFormat::TrueType);
    assert_eq!(
        (again.codepoints, again.advances),
        (mono.codepoints, mono.advances)
    );
    assert!(again.standalone.is_none());
    assert!(
        parse_font(&fixture("sans.ttf"))
            .unwrap()
            .standalone
            .is_none()
    );
}

#[test]
fn malformed_collections_are_rejected() {
    use unicode_art_core::font::extract_first_face;
    let ttc = fixture("collection.ttc");
    assert!(extract_first_face(&ttc[..20]).is_err());
    assert!(
        extract_first_face(b"ttcf\0\x02\0\0\0\0\0\0").is_err(),
        "no fonts"
    );
    assert!(
        extract_first_face(&fixture("sans.ttf")).is_err(),
        "not a collection"
    );
    let mut broken = ttc.clone();
    // Point the first table far beyond the end of the file.
    let dir = u32::from_be_bytes(broken[12..16].try_into().unwrap()) as usize;
    broken[dir + 12 + 8..dir + 12 + 12].copy_from_slice(&u32::MAX.to_be_bytes());
    assert!(extract_first_face(&broken).is_err());
}

#[test]
fn rejects_garbage() {
    assert_eq!(detect_format(b"abc"), None);
    assert_eq!(
        parse_font(b"not a font").unwrap_err(),
        FontError::UnknownFormat
    );
    let ttf = fixture("sans.ttf");
    assert!(matches!(parse_font(&ttf[..12]), Err(FontError::Parse(_))));
    let woff2 = fixture("sans.woff2");
    assert!(matches!(
        parse_font(&woff2[..64]),
        Err(FontError::Decode(_))
    ));
    for e in [
        FontError::UnknownFormat,
        FontError::Decode("x".into()),
        FontError::Parse("y".into()),
    ] {
        assert!(!e.to_string().is_empty());
    }
    for f in [
        FontFormat::TrueType,
        FontFormat::OpenType,
        FontFormat::Collection,
        FontFormat::Woff,
        FontFormat::Woff2,
    ] {
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

#[test]
fn arabic_fonts_only_contribute_their_non_joining_characters() {
    let f = parse_font(&fixture("arabic.ttf")).unwrap();
    // Latin letters, digits and the space remain.
    for cp in [0x20, 0x30, 0x39, 0x41, 0x5A] {
        assert!(f.codepoints.contains(&cp), "U+{cp:04X} missing");
    }
    // Joining letters, harakat, Arabic-Indic digits, joiners and the lam-alef
    // presentation ligature are all excluded although the font maps them.
    for cp in [
        0x0627, 0x0628, 0x0644, 0x0645, 0x064E, 0x0660, 0x0662, 0x200C, 0x200D, 0xFEFB,
    ] {
        assert!(!f.codepoints.contains(&cp), "U+{cp:04X} should be excluded");
    }
    assert!(
        f.codepoints
            .iter()
            .all(|&cp| !(0x0590..=0x08FF).contains(&cp))
    );
}

#[test]
fn shaping_features_do_not_change_coverage() {
    let f = parse_font(&fixture("features.ttf")).unwrap();
    // The ligature glyph is reachable through its own code point, and the
    // letters it is formed from stay individually usable.
    for cp in [0x66, 0x69, 0x61, 0x62, 0x63, 0x41, 0x56, 0xFB01] {
        assert!(f.codepoints.contains(&cp), "U+{cp:04X} missing");
    }
    let adv = |cp: u32| f.advances[f.codepoints.iter().position(|&c| c == cp).unwrap()];
    let plain = parse_font(&fixture("sans.ttf")).unwrap();
    let plain_adv =
        |cp: u32| plain.advances[plain.codepoints.iter().position(|&c| c == cp).unwrap()];
    // Kerning lives in GPOS and never alters the advances used for layout.
    assert_eq!(adv(0x41), plain_adv(0x41));
    assert_eq!(adv(0x56), plain_adv(0x56));
}

#[test]
fn variable_fonts_are_flagged() {
    let f = parse_font(&fixture("variable.ttf")).unwrap();
    assert!(f.is_variable);
    assert_eq!(f.family, "Fixture Variable");
    assert_eq!(f.codepoints.len(), 95);
    assert!(!parse_font(&fixture("sans.ttf")).unwrap().is_variable);
}
