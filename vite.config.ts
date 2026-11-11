import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { consoleForwardPlugin } from "vite-console-forward-plugin";

export default defineConfig(({ command, mode }) => {
  const isDev = command === "serve" || mode === "development";
  console.log(`Development mode: ${isDev}`);
  return {
    // Relative asset URLs, so the build works under any path (for example
    // https://example.com/some/dir/), not only at the site root.
    base: "./",
    plugins: [react(), tailwindcss(), isDev && consoleForwardPlugin()],
    resolve: {
      alias: {
        "@core": fileURLToPath(new URL("./wasm/pkg", import.meta.url)),
      },
    },
    server: { host: true, port: 12345, allowedHosts: true },
    build: {
      target: "es2023",
    },
  };
});
