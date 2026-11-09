import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const duckJs = fileURLToPath(new URL("../../app/src/core/duck.js", import.meta.url));

export default defineConfig({
  server: { port: 5181, fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
  worker: { format: "es" },
  build: {
    target: "es2022",
    rollupOptions: { input: { index: "index.html", app: "app.html" } },
  },
  plugins: [
    {
      name: "duck-shim",
      enforce: "pre",
      resolveId(source, importer) {
        if (importer && source.endsWith("core/duck.js") && resolve(dirname(importer), source) === duckJs) {
          return fileURLToPath(new URL("./duck-shim.js", import.meta.url));
        }
        return null;
      },
    },
  ],
});
