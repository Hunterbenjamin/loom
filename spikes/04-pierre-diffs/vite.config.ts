import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  publicDir: join(tmpdir(), "loom-spike-04", "data"),
  worker: { format: "es" },
});
