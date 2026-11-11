// Getting font bytes from files and URLs (including CSS such as Google Fonts).

export interface FontSource {
  name: string;
  bytes: Uint8Array;
}

const FONT_MAGIC = ["\u0000\u0001\u0000\u0000", "true", "OTTO", "ttcf", "wOFF", "wOF2"];

export function isFontData(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const head = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  return FONT_MAGIC.includes(head);
}

export function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return decodeURIComponent(last ?? u.hostname) || u.hostname;
  } catch {
    return url;
  }
}

/** First `url()` of every `@font-face` rule, resolved against `base`. */
export function extractFontUrls(css: string, base: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  for (const block of clean.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const src = /(?:^|;)\s*src\s*:([^;]*)/i.exec(block[1]);
    if (!src) continue;
    const url = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/i.exec(src[1]);
    const raw = url?.[1] ?? url?.[2] ?? url?.[3];
    if (!raw?.trim()) continue;
    try {
      const abs = new URL(raw, base).href;
      if (!out.includes(abs)) out.push(abs);
    } catch {
      // Ignore malformed URLs.
    }
  }
  return out;
}

async function download(url: string, fetchFn: typeof fetch): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchFn(url, { mode: "cors" });
  } catch {
    throw new Error(`Could not download ${url} (network error or the server does not allow cross-origin requests).`);
  }
  if (!res.ok) throw new Error(`Could not download ${url} (HTTP ${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Downloads a font, or every font referenced by a stylesheet. Fonts of a
 * stylesheet keep their order.
 */
export async function fetchFontSources(url: string, fetchFn: typeof fetch = fetch): Promise<FontSource[]> {
  const bytes = await download(url, fetchFn);
  if (isFontData(bytes)) return [{ name: nameFromUrl(url), bytes }];
  const text = new TextDecoder().decode(bytes);
  if (!/@font-face/i.test(text)) throw new Error("The URL is neither a font file nor a stylesheet with @font-face rules.");
  const urls = extractFontUrls(text, url);
  if (urls.length === 0) throw new Error("The stylesheet does not reference any font files.");
  const out: FontSource[] = [];
  for (const u of urls) out.push({ name: nameFromUrl(u), bytes: await download(u, fetchFn) });
  return out;
}
