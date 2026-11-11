// Helpers for user facing text, which must stay plain ASCII.

import type { ExclusionRule } from "../engine/backend";

/** Replaces anything outside printable ASCII with "?". */
export function asciiOnly(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "?");
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

export interface ExclusionSummary {
  categories: string;
  bidi: string;
  grapheme: string;
  ranges: { key: string; description: string }[];
}

/**
 * Condenses the exclusion rules: categories and bidi classes become one
 * line each (identical descriptions merged), ranges keep one line each.
 */
export function summarizeExclusions(rules: readonly ExclusionRule[]): ExclusionSummary {
  const join = (kind: ExclusionRule["kind"]) => {
    const groups = new Map<string, string[]>();
    for (const r of rules.filter((r) => r.kind === kind)) {
      const keys = groups.get(r.description) ?? [];
      keys.push(r.key);
      groups.set(r.description, keys);
    }
    return [...groups].map(([desc, keys]) => `${keys.join("/")} (${desc})`).join(", ");
  };
  return {
    categories: join("category"),
    bidi: join("bidi"),
    grapheme: rules
      .filter((r) => r.kind === "grapheme")
      .map((r) => r.description)
      .join(" "),
    ranges: rules.filter((r) => r.kind === "range").map(({ key, description }) => ({ key, description })),
  };
}

/**
 * Backslash escapes every ASCII punctuation character, which CommonMark (and
 * GitHub, Discord and most other Markdown flavors) then shows literally.
 * Whitespace and all other characters are kept as they are.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[!-/:-@[-`{-~]/g, "\\$&");
}
