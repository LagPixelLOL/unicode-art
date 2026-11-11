import type { ConfigEnv, UserConfig } from "vite";
import { describe, expect, it } from "vitest";
import config from "../../vite.config";
import { repoFile } from "./helpers/core";

describe("build configuration", () => {
  it("uses relative asset URLs so the site works under any path", async () => {
    const env: ConfigEnv = { command: "build", mode: "production", isSsrBuild: false, isPreview: false };
    const build = (typeof config === "function" ? await config(env) : await config) as UserConfig;
    expect(build.base).toBe("./");
    // Nothing in the app requests root relative URLs at run time.
    for (const file of ["src/engine/webgpu-wasm/core.ts", "src/fonts/presets.ts", "src/fonts/sources.ts", "index.html"]) {
      expect(repoFile(file)).not.toMatch(/(fetch\(|url\(|src=|href=)\s*["'`]\/(?!\/|src\/main\.tsx)/);
    }
  });
});
