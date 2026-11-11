// Predefined font sets, downloaded from Google Fonts at run time.

import { type FilesProgress, type LoadReport, download, loadStylesheetFaces, parseFontFaces } from "./sources";

export interface Preset {
  id: string;
  label: string;
  /** Google Fonts family names in priority order. */
  families: readonly string[];
}

/**
 * Every Noto family on Google Fonts except Noto Color Emoji (the output is
 * monochrome; the outline based Noto Emoji is included instead). Ordered
 * so the general purpose fonts come first: Sans, symbols, script specific
 * Sans fonts, CJK, then the Serif fonts and the remaining styles.
 */
export const NOTO_FAMILIES: readonly string[] = [
  "Noto Sans", "Noto Sans Symbols", "Noto Sans Symbols 2", "Noto Sans Math", "Noto Music", "Noto Sans Adlam",
  "Noto Sans Adlam Unjoined", "Noto Sans Anatolian Hieroglyphs", "Noto Sans Arabic", "Noto Sans Armenian",
  "Noto Sans Avestan", "Noto Sans Balinese", "Noto Sans Bamum", "Noto Sans Bassa Vah", "Noto Sans Batak",
  "Noto Sans Bengali", "Noto Sans Bhaiksuki", "Noto Sans Brahmi", "Noto Sans Buginese", "Noto Sans Buhid",
  "Noto Sans Canadian Aboriginal", "Noto Sans Carian", "Noto Sans Caucasian Albanian", "Noto Sans Chakma",
  "Noto Sans Cham", "Noto Sans Cherokee", "Noto Sans Chorasmian", "Noto Sans Coptic", "Noto Sans Cuneiform",
  "Noto Sans Cypriot", "Noto Sans Cypro Minoan", "Noto Sans Deseret", "Noto Sans Devanagari",
  "Noto Sans Duployan", "Noto Sans Egyptian Hieroglyphs", "Noto Sans Elbasan", "Noto Sans Elymaic",
  "Noto Sans Ethiopic", "Noto Sans Georgian", "Noto Sans Glagolitic", "Noto Sans Gothic",
  "Noto Sans Grantha", "Noto Sans Gujarati", "Noto Sans Gunjala Gondi", "Noto Sans Gurmukhi",
  "Noto Sans Hanifi Rohingya", "Noto Sans Hanunoo", "Noto Sans Hatran", "Noto Sans Hebrew",
  "Noto Sans Imperial Aramaic", "Noto Sans Indic Siyaq Numbers", "Noto Sans Inscriptional Pahlavi",
  "Noto Sans Inscriptional Parthian", "Noto Sans Javanese", "Noto Sans Kaithi", "Noto Sans Kannada",
  "Noto Sans Kawi", "Noto Sans Kayah Li", "Noto Sans Kharoshthi", "Noto Sans Khmer", "Noto Sans Khojki",
  "Noto Sans Khudawadi", "Noto Sans Lao", "Noto Sans Lao Looped", "Noto Sans Lepcha", "Noto Sans Limbu",
  "Noto Sans Linear A", "Noto Sans Linear B", "Noto Sans Lisu", "Noto Sans Lycian", "Noto Sans Lydian",
  "Noto Sans Mahajani", "Noto Sans Malayalam", "Noto Sans Mandaic", "Noto Sans Manichaean",
  "Noto Sans Marchen", "Noto Sans Masaram Gondi", "Noto Sans Mayan Numerals", "Noto Sans Medefaidrin",
  "Noto Sans Meetei Mayek", "Noto Sans Mende Kikakui", "Noto Sans Meroitic", "Noto Sans Miao",
  "Noto Sans Modi", "Noto Sans Mongolian", "Noto Sans Mro", "Noto Sans Multani", "Noto Sans Myanmar",
  "Noto Sans NKo", "Noto Sans NKo Unjoined", "Noto Sans Nabataean", "Noto Sans Nag Mundari",
  "Noto Sans Nandinagari", "Noto Sans New Tai Lue", "Noto Sans Newa", "Noto Sans Nushu", "Noto Sans Ogham",
  "Noto Sans Ol Chiki", "Noto Sans Old Hungarian", "Noto Sans Old Italic", "Noto Sans Old North Arabian",
  "Noto Sans Old Permic", "Noto Sans Old Persian", "Noto Sans Old Sogdian", "Noto Sans Old South Arabian",
  "Noto Sans Old Turkic", "Noto Sans Oriya", "Noto Sans Osage", "Noto Sans Osmanya",
  "Noto Sans Pahawh Hmong", "Noto Sans Palmyrene", "Noto Sans Pau Cin Hau", "Noto Sans PhagsPa",
  "Noto Sans Phoenician", "Noto Sans Psalter Pahlavi", "Noto Sans Rejang", "Noto Sans Runic",
  "Noto Sans Samaritan", "Noto Sans Saurashtra", "Noto Sans Sharada", "Noto Sans Shavian",
  "Noto Sans Siddham", "Noto Sans SignWriting", "Noto Sans Sinhala", "Noto Sans Sogdian",
  "Noto Sans Sora Sompeng", "Noto Sans Soyombo", "Noto Sans Sundanese", "Noto Sans Sunuwar",
  "Noto Sans Syloti Nagri", "Noto Sans Syriac", "Noto Sans Syriac Eastern", "Noto Sans Syriac Western",
  "Noto Sans Tagalog", "Noto Sans Tagbanwa", "Noto Sans Tai Le", "Noto Sans Tai Tham", "Noto Sans Tai Viet",
  "Noto Sans Takri", "Noto Sans Tamil", "Noto Sans Tamil Supplement", "Noto Sans Tangsa", "Noto Sans Telugu",
  "Noto Sans Thaana", "Noto Sans Thai", "Noto Sans Thai Looped", "Noto Sans Tifinagh", "Noto Sans Tirhuta",
  "Noto Sans Ugaritic", "Noto Sans Vai", "Noto Sans Vithkuqi", "Noto Sans Wancho", "Noto Sans Warang Citi",
  "Noto Sans Yi", "Noto Sans Zanabazar Square", "Noto Sans JP", "Noto Sans KR", "Noto Sans SC",
  "Noto Sans TC", "Noto Sans HK", "Noto Emoji", "Noto Sans Mono", "Noto Sans Display", "Noto Serif",
  "Noto Serif Display", "Noto Serif Ahom", "Noto Serif Armenian", "Noto Serif Balinese",
  "Noto Serif Bengali", "Noto Serif Devanagari", "Noto Serif Dives Akuru", "Noto Serif Dogra",
  "Noto Serif Ethiopic", "Noto Serif Georgian", "Noto Serif Grantha", "Noto Serif Gujarati",
  "Noto Serif Gurmukhi", "Noto Serif Hebrew", "Noto Serif Hentaigana", "Noto Serif Kannada",
  "Noto Serif Khitan Small Script", "Noto Serif Khmer", "Noto Serif Khojki", "Noto Serif Lao",
  "Noto Serif Makasar", "Noto Serif Malayalam", "Noto Serif Myanmar", "Noto Serif NP Hmong",
  "Noto Serif Old Uyghur", "Noto Serif Oriya", "Noto Serif Ottoman Siyaq", "Noto Serif Sinhala",
  "Noto Serif Tamil", "Noto Serif Tangut", "Noto Serif Telugu", "Noto Serif Thai", "Noto Serif Tibetan",
  "Noto Serif Todhri", "Noto Serif Toto", "Noto Serif Vithkuqi", "Noto Serif Yezidi", "Noto Serif JP",
  "Noto Serif KR", "Noto Serif SC", "Noto Serif TC", "Noto Serif HK", "Noto Kufi Arabic",
  "Noto Naskh Arabic", "Noto Nastaliq Urdu", "Noto Rashi Hebrew", "Noto Traditional Nushu",
  "Noto Znamenny Musical Notation",
];

const CJK = ["JP", "KR", "SC", "TC", "HK"];

export const PRESETS: readonly Preset[] = [
  { id: "noto-all", label: `Noto, entire family (${NOTO_FAMILIES.length} fonts)`, families: NOTO_FAMILIES },
  {
    id: "noto-sans",
    label: "Noto Sans with symbols and math",
    families: ["Noto Sans", "Noto Sans Symbols", "Noto Sans Symbols 2", "Noto Sans Math"],
  },
  {
    id: "noto-sans-cjk",
    label: "Noto Sans with symbols and CJK",
    families: ["Noto Sans", "Noto Sans Symbols", "Noto Sans Symbols 2", ...CJK.map((c) => `Noto Sans ${c}`)],
  },
  { id: "noto-serif", label: "Noto Serif", families: ["Noto Serif"] },
  { id: "noto-mono", label: "Noto Sans Mono", families: ["Noto Sans Mono"] },
  { id: "none", label: "No fonts (clear the list)", families: [] },
];

export const DEFAULT_PRESET = "noto-all";

const CSS_ENDPOINT = "https://fonts.googleapis.com/css2";
const FAMILIES_PER_REQUEST = 12;

/** Google Fonts CSS2 URLs for `families`, a few families per request. */
export function googleCssUrls(families: readonly string[], perRequest = FAMILIES_PER_REQUEST): string[] {
  const urls: string[] = [];
  for (let i = 0; i < families.length; i += perRequest) {
    const query = families
      .slice(i, i + perRequest)
      .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}`)
      .join("&");
    urls.push(`${CSS_ENDPOINT}?${query}`);
  }
  return urls;
}

export interface PresetProgress {
  phase: "stylesheets" | "files";
  done: number;
  total: number;
}

/** Downloads Google Fonts families. Families that fail are reported, not fatal. */
export async function loadGoogleFamilies(
  families: readonly string[],
  signal?: AbortSignal,
  onProgress?: (p: PresetProgress) => void,
  fetchFn: typeof fetch = fetch,
): Promise<LoadReport> {
  if (families.length === 0) return { fonts: [], warnings: [] };
  const urls = googleCssUrls(families);
  const warnings: string[] = [];
  let done = 0;
  onProgress?.({ phase: "stylesheets", done, total: urls.length });
  const sheets = await Promise.all(
    urls.map(async (url) => {
      try {
        const css = new TextDecoder().decode(await download(url, signal, fetchFn));
        return parseFontFaces(css, url);
      } catch (e) {
        if (signal?.aborted) throw e;
        warnings.push(e instanceof Error ? e.message : String(e));
        return [];
      } finally {
        onProgress?.({ phase: "stylesheets", done: ++done, total: urls.length });
      }
    }),
  );
  const files: FilesProgress = (d, total) => onProgress?.({ phase: "files", done: d, total });
  const report = await loadStylesheetFaces(sheets.flat(), families, signal, files, fetchFn);
  return { fonts: report.fonts, warnings: [...warnings, ...report.warnings] };
}
