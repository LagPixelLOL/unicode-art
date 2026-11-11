import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PRESET,
  NOTO_FAMILIES,
  PRESETS,
  googleCssUrls,
  loadGoogleFamilies,
  matchPreset,
} from "../../src/fonts/presets";
import {
  download,
  groupByFamily,
  isFontData,
  loadFontUrl,
  loadStylesheetFaces,
  mapLimit,
  nameFromUrl,
  parseFontFaces,
} from "../../src/fonts/sources";
import { SYNTHESIZED_SPACES, combineFaces, displayName, moveItem } from "../../src/fonts/store";
import { inRanges, parseUnicodeRange } from "../../src/fonts/unicodeRange";

const TTF = new Uint8Array([0, 1, 0, 0, 9, 9]);
const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1]);

const GOOGLE_CSS = `
/* latin-ext */
@font-face {
  font-family: 'Noto Sans';
  font-style: normal;
  src: url(https://fonts.gstatic.com/a.woff2) format('woff2');
  unicode-range: U+0100-02BA, U+1E00-1EFF;
}
/* latin */
@font-face {
  font-family: 'Noto Sans';
  src: url("https://fonts.gstatic.com/b.woff2") format('woff2');
  unicode-range: U+0000-00FF, U+2000-206F;
}
@font-face {
  font-family: "Noto Sans Symbols";
  src: local(Foo), url('sym.woff2') format('woff2'), url(other.ttf);
}
@font-face { font-family: Broken; }
@font-face { font-family: 'Empty'; src: url(); }
`;

type Route = Record<string, Uint8Array | string | number | Error>;

function fakeFetch(routes: Route, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    init?.signal?.throwIfAborted();
    const r = routes[url];
    if (r === undefined) return new Response("missing", { status: 404 });
    if (r instanceof Error) throw r;
    if (typeof r === "number") return new Response("x", { status: r });
    return new Response(typeof r === "string" ? r : r.slice());
  }) as typeof fetch;
}

describe("unicode-range", () => {
  it("parses singles, ranges and wildcards into merged sorted ranges", () => {
    expect(parseUnicodeRange("U+0131, U+0000-00FF, u+4??, U+0100-0101")).toEqual([
      [0, 0x101],
      [0x131, 0x131],
      [0x400, 0x4ff],
    ]);
    expect(parseUnicodeRange("U+10FFFF-110000")).toEqual([[0x10ffff, 0x10ffff]]);
    expect(parseUnicodeRange("U+110000")).toBeNull();
    expect(parseUnicodeRange("U+20-10")).toBeNull();
    expect(parseUnicodeRange("U+4?0")).toBeNull();
    expect(parseUnicodeRange("U+4?-50")).toBeNull();
    expect(parseUnicodeRange("latin")).toBeNull();
    expect(parseUnicodeRange(" , ")).toBeNull();
    expect(parseUnicodeRange("U+F0000-1FFFFF")).toEqual([[0xf0000, 0x10ffff]]);
  });

  it("looks up code points", () => {
    const r = parseUnicodeRange("U+0041-005A, U+0061, U+1F600-1F64F")!;
    for (const cp of [0x41, 0x5a, 0x61, 0x1f600, 0x1f64f]) expect(inRanges(r, cp)).toBe(true);
    for (const cp of [0x40, 0x5b, 0x60, 0x62, 0x1f650, 0]) expect(inRanges(r, cp)).toBe(false);
    expect(inRanges(null, 0x1234)).toBe(true);
    expect(inRanges([], 0x41)).toBe(false);
  });
});

describe("stylesheets and URLs", () => {
  it("parses @font-face rules", () => {
    const faces = parseFontFaces(GOOGLE_CSS, "https://fonts.googleapis.com/css2?family=x");
    expect(faces).toEqual([
      { family: "Noto Sans", url: "https://fonts.gstatic.com/a.woff2", unicodeRange: "U+0100-02BA, U+1E00-1EFF" },
      { family: "Noto Sans", url: "https://fonts.gstatic.com/b.woff2", unicodeRange: "U+0000-00FF, U+2000-206F" },
      { family: "Noto Sans Symbols", url: "https://fonts.googleapis.com/sym.woff2", unicodeRange: null },
    ]);
    const groups = groupByFamily(faces);
    expect([...groups.keys()]).toEqual(["Noto Sans", "Noto Sans Symbols"]);
    expect(groups.get("Noto Sans")).toHaveLength(2);
    // A rule without a family is named after its file.
    expect(parseFontFaces("@font-face { src: url(/x/My%20Font.woff) }", "https://h.test/")[0].family).toBe("My Font.woff");
    expect(parseFontFaces("@font-face { src: url(http://[bad) }", "https://h.test/")).toEqual([]);
  });

  it("recognizes font data and names", () => {
    expect(isFontData(TTF)).toBe(true);
    expect(isFontData(WOFF2)).toBe(true);
    expect(isFontData(new TextEncoder().encode("OTTO..."))).toBe(true);
    expect(isFontData(new TextEncoder().encode("<html>"))).toBe(false);
    expect(isFontData(new Uint8Array(2))).toBe(false);
    expect(nameFromUrl("https://a.test/fonts/Inter%20Var.woff2?x=1")).toBe("Inter Var.woff2");
    expect(nameFromUrl("https://a.test/")).toBe("a.test");
    expect(nameFromUrl("not a url")).toBe("not a url");
  });

  it("reports download failures clearly", async () => {
    const f = fakeFetch({ "https://a/x": 503, "https://a/net": new TypeError("fail") });
    await expect(download("https://a/x", undefined, f)).rejects.toThrow(/HTTP 503/);
    await expect(download("https://a/net", undefined, f)).rejects.toThrow(/CORS/);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(download("https://a/net", ctrl.signal, f)).rejects.toThrow();
  });

  it("limits concurrency, keeps order and stops on abort", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
    const ctrl = new AbortController();
    const seen: number[] = [];
    await expect(
      mapLimit(
        [1, 2, 3, 4],
        1,
        async (n) => {
          seen.push(n);
          if (n === 2) ctrl.abort();
        },
        ctrl.signal,
      ),
    ).rejects.toThrow();
    expect(seen).toEqual([1, 2]);
  });

  it("loads a font URL directly", async () => {
    const r = await loadFontUrl("https://h.test/f/A.ttf", undefined, undefined, fakeFetch({ "https://h.test/f/A.ttf": TTF }));
    expect(r.warnings).toEqual([]);
    expect(r.fonts).toHaveLength(1);
    expect(r.fonts[0]).toMatchObject({ name: "A.ttf", preferFamilyName: true });
    expect([...r.fonts[0].faces[0].bytes]).toEqual([...TTF]);
  });

  it("loads every family of a stylesheet URL, reporting broken files", async () => {
    const progress = vi.fn();
    const r = await loadFontUrl(
      "https://fonts.googleapis.com/css2?family=x",
      undefined,
      progress,
      fakeFetch({
        "https://fonts.googleapis.com/css2?family=x": GOOGLE_CSS,
        "https://fonts.gstatic.com/a.woff2": WOFF2,
        "https://fonts.gstatic.com/b.woff2": 500,
        "https://fonts.googleapis.com/sym.woff2": WOFF2,
      }),
    );
    expect(r.fonts.map((f) => [f.name, f.faces.length])).toEqual([
      ["Noto Sans", 1],
      ["Noto Sans Symbols", 1],
    ]);
    expect(r.fonts[0].faces[0].unicodeRange).toBe("U+0100-02BA, U+1E00-1EFF");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/HTTP 500/);
    expect(progress).toHaveBeenLastCalledWith(3, 3);
  });

  it("rejects bad URLs and non font content", async () => {
    const f = fakeFetch({ "https://h.test/page": "<html></html>", "https://h.test/empty.css": "@font-face { font-family: x }" });
    await expect(loadFontUrl("fonts.test/x.ttf", undefined, undefined, f)).rejects.toThrow(/full URL/);
    await expect(loadFontUrl("ftp://h.test/x.ttf", undefined, undefined, f)).rejects.toThrow(/Only http/);
    await expect(loadFontUrl("https://h.test/page", undefined, undefined, f)).rejects.toThrow(/neither a font/);
    await expect(loadFontUrl("https://h.test/empty.css", undefined, undefined, f)).rejects.toThrow(/any font files/);
  });

  it("orders stylesheet fonts by the requested families and reports missing ones", async () => {
    const faces = parseFontFaces(GOOGLE_CSS, "https://fonts.googleapis.com/");
    const r = await loadStylesheetFaces(
      faces,
      ["Noto Sans Symbols", "Missing", "Noto Sans"],
      undefined,
      undefined,
      fakeFetch({
        "https://fonts.gstatic.com/a.woff2": WOFF2,
        "https://fonts.gstatic.com/b.woff2": WOFF2,
        "https://fonts.googleapis.com/sym.woff2": WOFF2,
      }),
    );
    expect(r.fonts.map((f) => f.name)).toEqual(["Noto Sans Symbols", "Noto Sans"]);
    expect(r.fonts[1].faces).toHaveLength(2);
    expect(r.warnings).toEqual(["Missing: not offered by the font server."]);
  });
});

describe("presets", () => {
  it("lists the whole Noto family without the color emoji font", () => {
    expect(NOTO_FAMILIES.length).toBeGreaterThan(200);
    expect(new Set(NOTO_FAMILIES).size).toBe(NOTO_FAMILIES.length);
    expect(NOTO_FAMILIES[0]).toBe("Noto Sans");
    expect(NOTO_FAMILIES).toContain("Noto Emoji");
    expect(NOTO_FAMILIES).toContain("Noto Sans JP");
    expect(NOTO_FAMILIES).not.toContain("Noto Color Emoji");
    expect(PRESETS.find((p) => p.id === DEFAULT_PRESET)?.families).toBe(NOTO_FAMILIES);
    expect(PRESETS.find((p) => p.id === "none")?.families).toEqual([]);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });

  it("recognizes lists that match a preset", () => {
    expect(matchPreset([...NOTO_FAMILIES])).toBe("noto-all");
    expect(matchPreset(["Noto Sans Mono"])).toBe("noto-mono");
    expect(matchPreset([])).toBe("none");
    // Reordered, extended, shortened or containing user fonts: custom.
    expect(matchPreset(["Noto Sans Symbols", "Noto Sans", "Noto Sans Symbols 2", "Noto Sans Math"])).toBeNull();
    expect(matchPreset(["Noto Sans Mono", "Noto Serif"])).toBeNull();
    expect(matchPreset(NOTO_FAMILIES.slice(1))).toBeNull();
    expect(matchPreset([null])).toBeNull();
    expect(matchPreset(["Noto Serif"])).toBe("noto-serif");
  });

  it("batches families into CSS2 requests", () => {
    const urls = googleCssUrls(["Noto Sans", "Noto Sans Symbols 2", "A&B"], 2);
    expect(urls).toEqual([
      "https://fonts.googleapis.com/css2?family=Noto+Sans&family=Noto+Sans+Symbols+2",
      "https://fonts.googleapis.com/css2?family=A%26B",
    ]);
    expect(googleCssUrls(NOTO_FAMILIES).length).toBe(Math.ceil(NOTO_FAMILIES.length / 12));
  });

  it("downloads families and keeps going when a stylesheet fails", async () => {
    const fillers = Array.from({ length: 10 }, (_, i) => `Filler ${i}`);
    const families = ["Noto Sans", "Noto Sans Symbols", ...fillers, "Gone"];
    const [first, second] = googleCssUrls(families);
    expect(second).toBe("https://fonts.googleapis.com/css2?family=Gone");
    const phases: string[] = [];
    const r = await loadGoogleFamilies(
      families,
      undefined,
      (p) => phases.push(p.phase),
      fakeFetch({
        [first]: GOOGLE_CSS,
        [second]: 400,
        "https://fonts.gstatic.com/a.woff2": WOFF2,
        "https://fonts.gstatic.com/b.woff2": WOFF2,
        "https://fonts.googleapis.com/sym.woff2": WOFF2,
      }),
    );
    expect(r.fonts.map((f) => f.name)).toEqual(["Noto Sans", "Noto Sans Symbols"]);
    expect(r.warnings.some((w) => /HTTP 400/.test(w))).toBe(true);
    expect(r.warnings).toContain("Gone: not offered by the font server.");
    expect(phases).toContain("stylesheets");
    expect(phases).toContain("files");
    expect(await loadGoogleFamilies([])).toEqual({ fonts: [], warnings: [] });
  });

  it("can be cancelled", async () => {
    const ctrl = new AbortController();
    const f = (async (_: RequestInfo | URL, init?: RequestInit) => {
      ctrl.abort();
      init?.signal?.throwIfAborted();
      return new Response("");
    }) as typeof fetch;
    await expect(loadGoogleFamilies(["Noto Sans"], ctrl.signal, undefined, f)).rejects.toThrow();
  });
});

describe("font list helpers", () => {
  it("moves items", () => {
    expect(moveItem([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
    expect(moveItem([1, 2, 3, 4], 3, 0)).toEqual([4, 1, 2, 3]);
    expect(moveItem([1, 2, 3], 1, 1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], -1, 1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 0, 3)).toEqual([1, 2, 3]);
  });

  const face = (cps: number[], adv: number[], range: string | null) => ({
    info: { codepoints: Uint32Array.from(cps), advances: Uint16Array.from(adv), unitsPerEm: 1000 },
    ranges: range ? parseUnicodeRange(range) : null,
  });

  it("combines faces like CSS: later faces first, limited to their unicode-range", () => {
    const c = combineFaces([
      face([0x41, 0x42, 0x43], [100, 200, 300], "U+0041-0042"),
      face([0x42, 0x44], [900, 400], "U+0042, U+0044"),
    ]);
    expect([...c.codepoints]).toEqual([0x41, 0x42, 0x44]);
    expect([...c.advanceEm].map((v) => +v.toFixed(3))).toEqual([0.1, 0.9, 0.4]);
  });

  it("treats space characters the browser synthesizes as covered", () => {
    const c = combineFaces([face([0x20, 0x41, 0x2009], [250, 600, 200], null)]);
    const cps = [...c.codepoints];
    for (const cp of SYNTHESIZED_SPACES) expect(cps).toContain(cp);
    const at = (cp: number) => c.advanceEm[cps.indexOf(cp)];
    expect(at(0x2009)).toBeCloseTo(0.2);
    expect(Number.isNaN(at(0x200a))).toBe(true);
    // A face whose range excludes the space character does not synthesize.
    const none = combineFaces([face([0x20, 0x41], [250, 600], "U+0020-0041")]);
    expect([...none.codepoints]).toEqual([0x20, 0x41]);
    // Without a space glyph nothing is synthesized.
    expect([...combineFaces([face([0x41], [600], null)]).codepoints]).toEqual([0x41]);
  });

  it("prefers printable family names for files", () => {
    expect(displayName({ name: "a.ttf", preferFamilyName: true }, "Inter")).toBe("Inter");
    expect(displayName({ name: "a.ttf", preferFamilyName: true }, " ")).toBe("a.ttf");
    expect(displayName({ name: "a.ttf", preferFamilyName: true }, "\u6587\u6cc9")).toBe("a.ttf");
    expect(displayName({ name: "Noto Sans" }, "Other")).toBe("Noto Sans");
  });
});
