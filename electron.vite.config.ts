import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          cli: resolve(import.meta.dirname, "src/engine/cli.ts"),
          // The conversion engine runs as its own process, plus a headless CLI.
          engine: resolve(import.meta.dirname, "src/engine/worker.ts"),
          index: resolve(import.meta.dirname, "src/main/index.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/renderer/index.html"),
        },
      },
    },
    plugins: [react(), tailwindcss()],
    root: "src/renderer",
  },
});
