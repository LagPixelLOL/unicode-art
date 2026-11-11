// User facing files must be plain ASCII; only the rendered output may contain
// other characters, and that is produced at run time.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { repoFile, repoRoot } from "./helpers/core";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const root = fileURLToPath(repoRoot);

describe("ASCII only", () => {
  const files = [...walk(join(root, "src")), join(root, "index.html"), join(root, "README.md")];

  it.each(files.map((f) => [f.slice(root.length)]))("%s", (rel) => {
    const text = repoFile(rel);
    const bad = [...text.matchAll(/[^\x00-\x7f]/g)].map((m) => {
      const line = text.slice(0, m.index).split("\n").length;
      return `line ${line}: U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
    });
    expect(bad).toEqual([]);
  });

  it("covers the source tree", () => {
    expect(files.some((f) => f.endsWith("App.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("matcher.wgsl"))).toBe(true);
  });
});
