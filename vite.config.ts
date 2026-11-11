import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      "@core": fileURLToPath(new URL("./wasm/pkg", import.meta.url)),
    },
  },
  build: {
    target: "es2023",
  },
});
