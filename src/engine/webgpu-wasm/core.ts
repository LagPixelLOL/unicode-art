import init, * as core from "@core/core.js";
import wasmUrl from "@core/core_bg.wasm?url";

export type Core = typeof core;

let loading: Promise<Core> | null = null;

/** Instantiates the Rust compute core once. */
export function loadCore(): Promise<Core> {
  loading ??= init({ module_or_path: wasmUrl }).then(() => core);
  return loading;
}
