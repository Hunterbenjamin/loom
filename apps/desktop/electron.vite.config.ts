import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import {
  assertDevPortsAvailable,
  rendererServer,
} from "./scripts/dev-ports.js";

export default defineConfig(async ({ command }) => {
  if (command === "serve") await assertDevPortsAvailable(process.env);
  return {
    main: {
      plugins: [
        externalizeDepsPlugin({ exclude: ["@loom/protocol", "@loom/core"] }),
      ],
      build: { rollupOptions: { input: "src/main/index.ts" } },
    },
    preload: {
      plugins: [externalizeDepsPlugin({ exclude: ["@loom/core"] })],
      build: { rollupOptions: { input: "src/preload/index.ts" } },
    },
    renderer: {
      root: "src/renderer",
      server: rendererServer(process.env),
      plugins: [react()],
      // Pierre's syntax highlighting runs in a worker pool; without `es` the worker build
      // falls back to iife and the module worker import fails (spike 04).
      worker: { format: "es" as const },
      build: { rollupOptions: { input: "src/renderer/index.html" } },
    },
  };
});
