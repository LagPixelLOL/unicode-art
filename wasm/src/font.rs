//! Font container decoding and coverage extraction.

use crate::charset::is_usable;
use std::fmt;
use ttf_parser::{Face, GlyphId, name_id};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontFormat {
    TrueType,
    OpenType,
    Collection,
    Woff,
    Woff2,
}

impl FontFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            FontFormat::TrueType => "ttf",
            FontFormat::OpenType => "otf",
            FontFormat::Collection => "ttc",
            FontFormat::Woff => "woff",
            FontFormat::Woff2 => "woff2",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FontError {
    UnknownFormat,
    Decode(String),
    Parse(String),
}

impl fmt::Display for FontError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FontError::UnknownFormat => write!(f, "not a TTF, OTF, TTC, WOFF or WOFF2 font"),
            FontError::Decode(e) => write!(f, "could not decode font container: {e}"),
            FontError::Parse(e) => write!(f, "could not parse font: {e}"),
        }
    }
}

impl std::error::Error for FontError {}

pub fn detect_format(data: &[u8]) -> Option<FontFormat> {
    let magic = data.get(0..4)?;
    match magic {
        [0x00, 0x01, 0x00, 0x00] | b"true" => Some(FontFormat::TrueType),
        b"OTTO" => Some(FontFormat::OpenType),
        b"ttcf" => Some(FontFormat::Collection),
        b"wOFF" => Some(FontFormat::Woff),
        b"wOF2" => Some(FontFormat::Woff2),
        _ => None,
    }
}

fn be16(d: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(d.get(at..at + 2)?.try_into().ok()?))
}

fn be32(d: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(d.get(at..at + 4)?.try_into().ok()?))
}

/// Rebuilds the first face of a TrueType/OpenType collection as a
/// standalone font, since browsers do not accept collections as web fonts.
pub fn extract_first_face(data: &[u8]) -> Result<Vec<u8>, FontError> {
    let bad = || FontError::Parse("malformed font collection".into());
    if data.get(0..4) != Some(b"ttcf") {
        return Err(bad());
    }
    let count = be32(data, 8).ok_or_else(bad)?;
    if count == 0 {
        return Err(bad());
    }
    let dir = be32(data, 12).ok_or_else(bad)? as usize;
    let num_tables = be16(data, dir + 4).ok_or_else(bad)? as usize;
    let header_len = 12 + 16 * num_tables;
    let header = data.get(dir..dir + header_len).ok_or_else(bad)?;
    let mut out = header.to_vec();
    for i in 0..num_tables {
        let rec = 12 + 16 * i;
        let offset = be32(header, rec + 8).ok_or_else(bad)? as usize;
        let length = be32(header, rec + 12).ok_or_else(bad)? as usize;
        let table = data
            .get(offset..offset.checked_add(length).ok_or_else(bad)?)
            .ok_or_else(bad)?;
        while out.len() % 4 != 0 {
            out.push(0);
        }
        let new_offset = out.len() as u32;
        out[rec + 8..rec + 12].copy_from_slice(&new_offset.to_be_bytes());
        out.extend_from_slice(table);
    }
    while out.len() % 4 != 0 {
        out.push(0);
    }
    Ok(out)
}

/// Information about the first face of a font file.
#[derive(Debug, Clone)]
pub struct ParsedFont {
    pub format: FontFormat,
    pub family: String,
    pub units_per_em: u16,
    pub ascender: i16,
    pub descender: i16,
    pub line_gap: i16,
    pub glyph_count: u16,
    pub is_variable: bool,
    /// Glyphs skipped because they are drawn in color (COLR, CBDT, sbix, SVG).
    pub color_glyphs: u32,
    /// Sorted usable code points that map to a real (non .notdef) glyph.
    pub codepoints: Vec<u32>,
    /// Horizontal advance in font units for each entry of `codepoints`.
    pub advances: Vec<u16>,
    /// For collections: the first face as a standalone font for the browser.
    pub standalone: Option<Vec<u8>>,
}

fn family_name(face: &Face<'_>) -> String {
    let pick = |id: u16| {
        face.names()
            .into_iter()
            .filter(|n| n.name_id == id && n.is_unicode())
            .find_map(|n| n.to_string())
    };
    pick(name_id::TYPOGRAPHIC_FAMILY)
        .or_else(|| pick(name_id::FAMILY))
        .unwrap_or_default()
}

/// Parses the first face of `data`. WOFF and WOFF2 containers are decoded first.
pub fn parse_font(data: &[u8]) -> Result<ParsedFont, FontError> {
    let format = detect_format(data).ok_or(FontError::UnknownFormat)?;
    let decoded;
    let sfnt: &[u8] = match format {
        FontFormat::Woff => {
            decoded =
                wuff::decompress_woff1(data).map_err(|e| FontError::Decode(format!("{e:?}")))?;
            &decoded
        }
        FontFormat::Woff2 => {
            decoded =
                wuff::decompress_woff2(data).map_err(|e| FontError::Decode(format!("{e:?}")))?;
            &decoded
        }
        _ => data,
    };
    let face = Face::parse(sfnt, 0).map_err(|e| FontError::Parse(e.to_string()))?;

    let mut all: Vec<u32> = Vec::new();
    if let Some(cmap) = face.tables().cmap {
        for sub in cmap.subtables {
            if sub.is_unicode() {
                sub.codepoints(|cp| all.push(cp));
            }
        }
    }
    all.sort_unstable();
    all.dedup();

    let tables = face.tables();
    let has_color = tables.colr.is_some()
        || tables.sbix.is_some()
        || tables.cbdt.is_some()
        || tables.svg.is_some();
    let is_color = |gid: GlyphId| {
        face.is_color_glyph(gid)
            || face.glyph_raster_image(gid, u16::MAX).is_some()
            || face.glyph_svg_image(gid).is_some()
    };
    let mut color_glyphs = 0;
    let mut codepoints = Vec::with_capacity(all.len());
    let mut advances = Vec::with_capacity(all.len());
    for cp in all {
        if !is_usable(cp) {
            continue;
        }
        let Some(ch) = char::from_u32(cp) else {
            continue;
        };
        let Some(gid) = face.glyph_index(ch) else {
            continue;
        };
        if gid == GlyphId(0) {
            continue;
        }
        let adv = face.glyph_hor_advance(gid).unwrap_or(0);
        if adv == 0 {
            continue;
        }
        // The output is monochrome text; color glyphs would not render as such.
        if has_color && is_color(gid) {
            color_glyphs += 1;
            continue;
        }
        codepoints.push(cp);
        advances.push(adv);
    }

    Ok(ParsedFont {
        format,
        family: family_name(&face),
        units_per_em: face.units_per_em(),
        ascender: face.ascender(),
        descender: face.descender(),
        line_gap: face.line_gap(),
        glyph_count: face.number_of_glyphs(),
        is_variable: face.is_variable(),
        color_glyphs,
        codepoints,
        advances,
        standalone: if format == FontFormat::Collection {
            Some(extract_first_face(data)?)
        } else {
            None
        },
    })
}
