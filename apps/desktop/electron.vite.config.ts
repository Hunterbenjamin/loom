import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({ exclude: ["@loom/protocol", "@loom/core"] }),
    ],
    build: { rollupOptions: { input: "src/main/index.ts" } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: "src/preload/index.ts" } },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    // Pierre's syntax highlighting runs in a worker pool; without `es` the worker build
    // falls back to iife and the module worker import fails (spike 04).
    worker: { format: "es" },
    build: { rollupOptions: { input: "src/renderer/index.html" } },
  },
});
