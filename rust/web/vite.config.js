import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  server: { port: 5181, fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
  worker: { format: "es" },
});
