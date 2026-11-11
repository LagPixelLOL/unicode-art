//! Character eligibility rules and priority based coverage merging.
//!
//! The output is rendered natively by the browser as plain text, so only code
//! points that occupy exactly one predictable, left-to-right advance are
//! usable. Anything that combines, joins, reorders, or is invisible by
//! definition is rejected here.

use unicode_bidi::{BidiClass, bidi_class};
use unicode_general_category::{GeneralCategory, get_general_category};
use unicode_segmentation::UnicodeSegmentation;

/// Ranges of scripts that require complex shaping (conjuncts, contextual
/// joining, reordering or stacking), right-to-left scripts, and sequence
/// forming characters (regional indicators, emoji modifiers, tags).
pub const EXCLUDED_RANGES: &[(u32, u32, &str)] = &[
    (0x0590, 0x08FF, "Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic, Arabic ext"),
    (0x0900, 0x0DFF, "Indic scripts, Devanagari to Sinhala"),
    (0x0F00, 0x0FFF, "Tibetan"),
    (0x1000, 0x109F, "Myanmar"),
    (0x1100, 0x11FF, "Hangul Jamo (conjoining)"),
    (0x1700, 0x18AF, "Philippine scripts, Khmer, Mongolian"),
    (0x1900, 0x1AFF, "Limbu to Tai Tham, combining diacritics ext"),
    (0x1B00, 0x1C4F, "Balinese, Sundanese, Batak, Lepcha"),
    (0x1CD0, 0x1CFF, "Vedic extensions"),
    (0x3164, 0x3164, "Hangul filler (default ignorable)"),
    (0xA800, 0xA8FF, "Syloti Nagri, Phags-pa, Saurashtra, Devanagari ext"),
    (0xA900, 0xA9FF, "Kayah Li, Rejang, Hangul Jamo ext A, Javanese"),
    (0xAA00, 0xAAFF, "Cham, Myanmar ext, Tai Viet, Meetei Mayek ext"),
    (0xABC0, 0xABFF, "Meetei Mayek"),
    (0xD7B0, 0xD7FF, "Hangul Jamo ext B"),
    (0xFB1D, 0xFDFF, "Hebrew and Arabic presentation forms"),
    (0xFE00, 0xFE0F, "Variation selectors"),
    (0xFE70, 0xFEFF, "Arabic presentation forms B, BOM"),
    (0xFFA0, 0xFFA0, "Halfwidth Hangul filler"),
    (0x10800, 0x10FFF, "Historic right-to-left scripts"),
    (0x11000, 0x11FFF, "Brahmi and other historic Indic scripts"),
    (0x1E800, 0x1EFFF, "Mende Kikakui, Adlam, Arabic math and other RTL"),
    (0x1F1E6, 0x1F1FF, "Regional indicators (form flags in pairs)"),
    (0x1F3FB, 0x1F3FF, "Emoji skin tone modifiers"),
    (0xE0000, 0xE0FFF, "Tags and variation selectors supplement"),
];

/// General categories that are never usable, with a short description.
pub const EXCLUDED_CATEGORIES: &[(GeneralCategory, &str, &str)] = &[
    (GeneralCategory::Control, "Cc", "control characters"),
    (GeneralCategory::Format, "Cf", "format characters (zero width, bidi controls, joiners)"),
    (GeneralCategory::Surrogate, "Cs", "surrogates"),
    (GeneralCategory::Unassigned, "Cn", "unassigned code points and noncharacters"),
    (GeneralCategory::NonspacingMark, "Mn", "nonspacing combining marks"),
    (GeneralCategory::SpacingMark, "Mc", "spacing combining marks"),
    (GeneralCategory::EnclosingMark, "Me", "enclosing marks"),
    (GeneralCategory::LineSeparator, "Zl", "line separator"),
    (GeneralCategory::ParagraphSeparator, "Zp", "paragraph separator"),
];

/// Bidi classes that are never usable, with a short description.
pub const EXCLUDED_BIDI: &[(BidiClass, &str, &str)] = &[
    (BidiClass::R, "R", "right-to-left letters"),
    (BidiClass::AL, "AL", "Arabic letters"),
    (BidiClass::AN, "AN", "Arabic digits"),
    (BidiClass::NSM, "NSM", "nonspacing marks"),
    (BidiClass::B, "B", "paragraph separators"),
    (BidiClass::S, "S", "segment separators such as tab"),
    (BidiClass::BN, "BN", "boundary neutrals"),
    (BidiClass::LRE, "LRE", "embedding and override controls"),
    (BidiClass::LRO, "LRO", "embedding and override controls"),
    (BidiClass::RLE, "RLE", "embedding and override controls"),
    (BidiClass::RLO, "RLO", "embedding and override controls"),
    (BidiClass::PDF, "PDF", "embedding and override controls"),
    (BidiClass::LRI, "LRI", "isolate controls"),
    (BidiClass::RLI, "RLI", "isolate controls"),
    (BidiClass::FSI, "FSI", "isolate controls"),
    (BidiClass::PDI, "PDI", "isolate controls"),
];

/// Description of the grapheme cluster rule (see `joins_neighbours`).
pub const GRAPHEME_RULE: (&str, &str) = (
    "Grapheme_Cluster_Break",
    "characters that join the character before or after them into one grapheme cluster (Extend, SpacingMark, Prepend, ZWJ, Hangul jamo), such as U+FF9E",
);

/// Usable characters a candidate is tested next to: a Latin letter and
/// Hangul LV and LVT syllables (which absorb trailing jamo).
const CLUSTER_CONTEXTS: [char; 3] = ['a', '\u{AC00}', '\u{AC01}'];

/// True when `ch` forms one grapheme cluster with a usable neighbour (or with
/// itself). Browsers lay out, select and measure such clusters as a unit,
/// so the character would not get its own advance.
pub fn joins_neighbours(ch: char) -> bool {
    let joined = |a: char, b: char| {
        let mut s = String::with_capacity(8);
        s.push(a);
        s.push(b);
        s.graphemes(true).nth(1).is_none()
    };
    joined(ch, ch) || CLUSTER_CONTEXTS.iter().any(|&c| joined(c, ch) || joined(ch, c))
}

/// Returns true when the code point can be emitted as a standalone, single
/// advance, left-to-right character.
pub fn is_usable(cp: u32) -> bool {
    let Some(ch) = char::from_u32(cp) else {
        return false;
    };
    if EXCLUDED_RANGES.iter().any(|&(lo, hi, _)| cp >= lo && cp <= hi) {
        return false;
    }
    let gc = get_general_category(ch);
    if EXCLUDED_CATEGORIES.iter().any(|&(c, _, _)| c == gc) {
        return false;
    }
    let bc = bidi_class(ch);
    if EXCLUDED_BIDI.iter().any(|&(c, _, _)| c == bc) {
        return false;
    }
    !joins_neighbours(ch)
}

/// Plain ASCII description of every exclusion rule, one rule per line, in the
/// form `kind<TAB>key<TAB>description`. Kinds are `range`, `category`,
/// `bidi` and `grapheme`.
pub fn exclusion_rules() -> String {
    let mut out = String::new();
    for &(lo, hi, label) in EXCLUDED_RANGES {
        let key = if lo == hi { format!("U+{lo:04X}") } else { format!("U+{lo:04X}-U+{hi:04X}") };
        out.push_str(&format!("range\t{key}\t{label}\n"));
    }
    for &(_, key, label) in EXCLUDED_CATEGORIES {
        out.push_str(&format!("category\t{key}\t{label}\n"));
    }
    for &(_, key, label) in EXCLUDED_BIDI {
        out.push_str(&format!("bidi\t{key}\t{label}\n"));
    }
    out.push_str(&format!("grapheme\t{}\t{}\n", GRAPHEME_RULE.0, GRAPHEME_RULE.1));
    out
}

/// Result of merging the coverage of several fonts in priority order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MergedCharset {
    /// Sorted, unique code points.
    pub codepoints: Vec<u32>,
    /// For every code point, the index of the highest priority font that has it.
    pub font_index: Vec<u32>,
}

/// Merges per font coverage lists. `fonts[0]` has the highest priority. Each
/// list must be sorted ascending; duplicates inside a list are tolerated.
pub fn merge_coverage(fonts: &[&[u32]]) -> MergedCharset {
    let mut all: Vec<(u32, u32)> = fonts
        .iter()
        .enumerate()
        .flat_map(|(fi, cps)| cps.iter().map(move |&cp| (cp, fi as u32)))
        .collect();
    // Sorting by (codepoint, font index) puts the highest priority font first.
    all.sort_unstable();
    let mut out = MergedCharset::default();
    for (cp, fi) in all {
        if out.codepoints.last() == Some(&cp) {
            continue;
        }
        out.codepoints.push(cp);
        out.font_index.push(fi);
    }
    out
}
