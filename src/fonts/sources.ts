// Getting font bytes from files, font URLs and stylesheets (Google Fonts).

export interface FaceSource {
  bytes: Uint8Array;
  /** CSS unicode-range declared for this face, if any. */
  unicodeRange: string | null;
  label: string;
}

/** One entry of the priority list: a font family made of one or more faces. */
export interface FontSource {
  name: string;
  faces: FaceSource[];
  /** Prefer the family name stored in the font over `name` (for files). */
  preferFamilyName?: boolean;
}

export interface CssFace {
  family: string;
  url: string;
  unicodeRange: string | null;
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
    return (last && decodeURIComponent(last)) || u.hostname;
  } catch {
    return url;
  }
}

function unquote(s: string): string {
  return s.trim().replace(/^(["'])(.*)\1$/, "$2");
}

/** Every `@font-face` rule with its family, first source URL and range. */
export function parseFontFaces(css: string, base: string): CssFace[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: CssFace[] = [];
  for (const block of clean.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const decls = new Map<string, string>();
    for (const part of block[1].split(";")) {
      const i = part.indexOf(":");
      if (i > 0) decls.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
    }
    const src = decls.get("src");
    if (!src) continue;
    const m = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/i.exec(src);
    const raw = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
    if (!raw) continue;
    let url: string;
    try {
      url = new URL(raw, base).href;
    } catch {
      continue;
    }
    out.push({
      family: unquote(decls.get("font-family") ?? "") || nameFromUrl(url),
      url,
      unicodeRange: decls.get("unicode-range") ?? null,
    });
  }
  return out;
}

/** Groups faces by family, keeping the order of first appearance. */
export function groupByFamily(faces: readonly CssFace[]): Map<string, CssFace[]> {
  const out = new Map<string, CssFace[]>();
  for (const f of faces) {
    const list = out.get(f.family) ?? [];
    list.push(f);
    out.set(f.family, list);
  }
  return out;
}

export class DownloadError extends Error {}

export async function download(url: string, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchFn(url, { mode: "cors", signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new DownloadError(
      `Could not download ${url}: network error, or the server does not allow cross-origin requests (CORS).`,
    );
  }
  if (!res.ok) throw new DownloadError(`Could not download ${url}: the server answered HTTP ${res.status}.`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Runs `fn` over `items` with at most `limit` calls in flight, in order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      signal?.throwIfAborted();
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface LoadReport {
  fonts: FontSource[];
  /** Problems that did not prevent loading the rest. */
  warnings: string[];
}

export type FilesProgress = (done: number, total: number) => void;

/** Downloads the faces of a stylesheet, one FontSource per family. */
export async function loadStylesheetFaces(
  faces: readonly CssFace[],
  families: readonly string[] | null,
  signal?: AbortSignal,
  onProgress?: FilesProgress,
  fetchFn: typeof fetch = fetch,
): Promise<LoadReport> {
  const groups = groupByFamily(faces);
  const order = families ?? [...groups.keys()];
  const warnings: string[] = [];
  const wanted = order.flatMap((f) => groups.get(f) ?? []);
  for (const f of order) if (!groups.has(f)) warnings.push(`${f}: not offered by the font server.`);
  let done = 0;
  onProgress?.(0, wanted.length);
  const results = await mapLimit(
    wanted,
    12,
    async (face) => {
      try {
        const bytes = await download(face.url, signal, fetchFn);
        return { face, bytes };
      } catch (e) {
        if (signal?.aborted) throw e;
        warnings.push(e instanceof Error ? e.message : String(e));
        return { face, bytes: null };
      } finally {
        onProgress?.(++done, wanted.length);
      }
    },
    signal,
  );
  const fonts: FontSource[] = [];
  for (const family of order) {
    const loaded = results.filter((r) => r.face.family === family && r.bytes);
    if (loaded.length === 0) continue;
    fonts.push({
      name: family,
      faces: loaded.map((r) => ({ bytes: r.bytes!, unicodeRange: r.face.unicodeRange, label: nameFromUrl(r.face.url) })),
    });
  }
  return { fonts, warnings };
}

/**
 * Downloads a font file, or every family of a stylesheet such as
 * https://fonts.googleapis.com/css2?family=Noto+Sans.
 */
export async function loadFontUrl(
  url: string,
  signal?: AbortSignal,
  onProgress?: FilesProgress,
  fetchFn: typeof fetch = fetch,
): Promise<LoadReport> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DownloadError("Enter a full URL, starting with https://.");
  }
  if (!["http:", "https:", "data:", "blob:"].includes(parsed.protocol)) {
    throw new DownloadError("Only http, https, data and blob URLs are supported.");
  }
  const bytes = await download(url, signal, fetchFn);
  if (isFontData(bytes)) {
    const name = nameFromUrl(url);
    return { fonts: [{ name, faces: [{ bytes, unicodeRange: null, label: name }], preferFamilyName: true }], warnings: [] };
  }
  const text = new TextDecoder().decode(bytes);
  if (!/@font-face/i.test(text)) {
    throw new DownloadError("The URL is neither a font file nor a stylesheet with @font-face rules.");
  }
  const faces = parseFontFaces(text, url);
  if (faces.length === 0) throw new DownloadError("The stylesheet does not reference any font files.");
  return loadStylesheetFaces(faces, null, signal, onProgress, fetchFn);
}
