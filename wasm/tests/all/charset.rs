use unicode_art_core::charset::{
    EXCLUDED_RANGES, exclusion_rules, is_usable, joins_neighbours, merge_coverage,
};

#[test]
fn accepts_plain_left_to_right_characters() {
    for cp in [
        0x20, 0x41, 0x7E, 0xA0, 0xE9, 0x3000, 0x4E00, 0x2588, 0xE000, 0x1F600, 0x0E01, 0xAC00,
        // Ogham space mark is visible, hangul syllables are precomposed,
        // fullwidth forms, box drawing, braille, math alphanumerics.
        0x1680, 0xD7A3, 0xFF21, 0x2500, 0x2800, 0x1D400, 0x20AC, 0xFB01, 0x200A, 0x3042,
    ] {
        assert!(is_usable(cp), "U+{cp:04X} should be usable");
    }
}

#[test]
fn rejects_unusable_characters() {
    let cases = [
        (0x09, "tab"),
        (0x0A, "line feed"),
        (0x7F, "delete"),
        (0x0301, "combining acute"),
        (0x20DD, "enclosing circle"),
        (0x05D0, "hebrew alef"),
        (0x0627, "arabic alef"),
        (0x0915, "devanagari ka"),
        (0x0E31, "thai mark"),
        (0x1100, "conjoining jamo"),
        (0x200B, "zero width space"),
        (0x200D, "zero width joiner"),
        (0x202E, "right-to-left override"),
        (0x2028, "line separator"),
        (0x2029, "paragraph separator"),
        (0xFE0F, "variation selector"),
        (0xFEFF, "byte order mark"),
        (0xFFFF, "noncharacter"),
        (0x1F1E6, "regional indicator"),
        (0x1F3FB, "skin tone modifier"),
        (0xE0041, "tag"),
        (0xD800, "surrogate"),
        (0x110000, "beyond unicode"),
        (0x3164, "hangul filler"),
        (0x0628, "arabic beh (joining)"),
        (0x0644, "arabic lam"),
        (0x064E, "arabic fatha"),
        (0x0660, "arabic-indic digit zero"),
        (0x06F0, "extended arabic-indic digit"),
        (0x0710, "syriac alaph"),
        (0x07C0, "nko digit"),
        (0xFB50, "arabic presentation form"),
        (0xFEFB, "lam-alef ligature form"),
        (0xFDFD, "bismillah ligature"),
        (0x200C, "zero width non-joiner"),
        (0x200E, "left-to-right mark"),
        (0x2066, "left-to-right isolate"),
        (0x2069, "pop directional isolate"),
        (0x094D, "devanagari virama"),
        (0x0BCD, "tamil virama"),
        (0x0E48, "thai tone mark"),
        (0x0F40, "tibetan letter"),
        (0x1820, "mongolian letter"),
        (0x180B, "mongolian variation selector"),
        (0x1160, "hangul jungseong filler"),
        (0x034F, "combining grapheme joiner"),
        (0x00AD, "soft hyphen"),
        (0x2060, "word joiner"),
        (0x20E3, "combining enclosing keycap"),
        (0xFFF9, "interlinear annotation anchor"),
        (0xE0100, "variation selector supplement"),
        (0xE007F, "cancel tag"),
        (0x10900, "phoenician (right-to-left)"),
        (0x1E900, "adlam (right-to-left, joining)"),
        (0x11000, "brahmi sign"),
        (
            0xFF9E,
            "halfwidth katakana voiced sound mark (grapheme extend)",
        ),
        (
            0xFF9F,
            "halfwidth katakana semi-voiced sound mark (grapheme extend)",
        ),
        (0x0E33, "thai sara am (spacing mark)"),
        (0x0EB3, "lao vowel sign am (spacing mark)"),
        (0x302E, "hangul single dot tone mark"),
        (0x1D165, "musical symbol combining stem"),
        (0x11A8, "hangul trailing jamo"),
    ];
    for (cp, name) in cases {
        assert!(!is_usable(cp), "{name} (U+{cp:04X}) should be rejected");
    }
}

#[test]
fn grapheme_cluster_members_are_rejected() {
    for cp in [0xFF9E, 0x0E33, 0x0301, 0x200D, 0x1F3FB, 0xE0020] {
        assert!(
            joins_neighbours(char::from_u32(cp).unwrap()),
            "U+{cp:04X} joins"
        );
    }
    // Standalone characters, including Hangul syllables and emoji.
    for cp in [
        0x41, 0x20, 0xAC00, 0xD7A3, 0x4E00, 0xFF9D, 0x30AC, 0x1F600, 0x2588, 0x0E01,
    ] {
        assert!(
            !joins_neighbours(char::from_u32(cp).unwrap()),
            "U+{cp:04X} stands alone"
        );
    }
    // Every printable ASCII character stays usable.
    assert!((0x20..0x7F).all(is_usable));
}

#[test]
fn every_excluded_range_is_rejected_at_its_bounds() {
    for &(lo, hi, _) in EXCLUDED_RANGES {
        assert!(!is_usable(lo) && !is_usable(hi), "U+{lo:04X}-U+{hi:04X}");
        assert!(lo <= hi);
    }
}

#[test]
fn exclusion_rules_are_ascii_and_complete() {
    let text = exclusion_rules();
    assert!(text.is_ascii());
    let lines: Vec<&str> = text.lines().collect();
    assert!(lines.iter().all(|l| l.split('\t').count() == 3), "{text}");
    for &(lo, hi, _) in EXCLUDED_RANGES {
        let key = if lo == hi {
            format!("U+{lo:04X}")
        } else {
            format!("U+{lo:04X}-U+{hi:04X}")
        };
        assert!(
            lines
                .iter()
                .any(|l| l.starts_with(&format!("range\t{key}\t"))),
            "{key}"
        );
    }
    for key in [
        "category\tMn\t",
        "category\tCc\t",
        "category\tCf\t",
        "bidi\tR\t",
        "bidi\tAL\t",
        "grapheme\tGrapheme_Cluster_Break\t",
    ] {
        assert!(lines.iter().any(|l| l.starts_with(key)), "{key}");
    }
}

#[test]
fn readme_documents_every_rule() {
    let readme = std::fs::read_to_string(crate::repo_root().join("README.md")).expect("README.md");
    for line in exclusion_rules().lines() {
        let key = line.split('\t').nth(1).unwrap();
        assert!(
            readme.contains(&format!("`{key}`")),
            "README.md does not list `{key}`"
        );
    }
}

#[test]
fn merge_prefers_earlier_fonts() {
    let a: &[u32] = &[0x41, 0x42, 0x44];
    let b: &[u32] = &[0x40, 0x42, 0x43, 0x44, 0x44];
    let c: &[u32] = &[0x45];
    let merged = merge_coverage(&[a, b, c]);
    assert_eq!(merged.codepoints, vec![0x40, 0x41, 0x42, 0x43, 0x44, 0x45]);
    assert_eq!(merged.font_index, vec![1, 0, 0, 1, 0, 2]);

    let swapped = merge_coverage(&[b, a]);
    assert_eq!(swapped.font_index, vec![0, 1, 0, 0, 0]);
    assert!(merge_coverage(&[]).codepoints.is_empty());
}
