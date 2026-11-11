// Loads the compiled compute core into Node, no browser involved.

import { readFileSync } from "node:fs";
import * as core from "@core/core.js";

const root = new URL("../../../", import.meta.url);
let ready = false;

export function loadCore(): typeof core {
  if (!ready) {
    core.initSync({ module: readFileSync(new URL("wasm/pkg/core_bg.wasm", root)) });
    ready = true;
  }
  return core;
}

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`tests/fixtures/fonts/${name}`, root)));
}

export function repoFile(path: string): string {
  return readFileSync(new URL(path, root), "utf8");
}

export const repoRoot = root;
