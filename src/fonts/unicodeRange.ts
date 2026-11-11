// CSS unicode-range handling.

export type CodeRange = readonly [number, number];

const MAX_CP = 0x10ffff;

/**
 * Parses a CSS unicode-range value ("U+0000-00FF, U+0131, U+4??").
 * Returns sorted, merged ranges, or null when the value is invalid.
 */
export function parseUnicodeRange(value: string): CodeRange[] | null {
  const out: [number, number][] = [];
  for (const raw of value.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const m = /^u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?$/i.exec(token);
    if (!m) return null;
    let lo: number;
    let hi: number;
    if (m[1].includes("?")) {
      if (m[2] || !/^[0-9a-f]*\?+$/i.test(m[1])) return null;
      lo = parseInt(m[1].replace(/\?/g, "0"), 16);
      hi = parseInt(m[1].replace(/\?/g, "f"), 16);
    } else {
      lo = parseInt(m[1], 16);
      hi = m[2] ? parseInt(m[2], 16) : lo;
    }
    if (lo > hi || lo > MAX_CP) return null;
    out.push([lo, Math.min(hi, MAX_CP)]);
  }
  if (out.length === 0) return null;
  out.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [out[0]];
  for (const r of out.slice(1)) {
    const last = merged[merged.length - 1];
    if (r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push(r);
  }
  return merged;
}

/** Whether `cp` lies in sorted, merged `ranges` (null means everything). */
export function inRanges(ranges: readonly CodeRange[] | null, cp: number): boolean {
  if (!ranges) return true;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}
