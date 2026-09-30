import { defineConfig } from "vite";
import { resolve } from "node:path";

/*
 * The app lives in app/. `vite build` makes the production site in dist/;
 * `vite build --mode test` also builds the test-only harness entry
 * (app/testing/harness.html) into dist-test/, which the browser suites drive.
 * The production build never contains the harness.
 */
export default defineConfig(({ mode }) => ({
  root: "app",
  base: "./",
  build: {
    outDir: resolve(mode === "test" ? "dist-test" : "dist"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: {
        main: resolve("app/index.html"),
        ...(mode === "test" ? { harness: resolve("app/testing/harness.html") } : {}),
      },
    },
  },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
  server: {
    // The harness core lives in tests/; the test entry imports it.
    fs: { allow: [resolve(".")] },
    // With the local server running (`cd server && uv run geomarmot --no-browser --token dev`),
    // open http://localhost:5173/#t=dev and the proxy, listing and session routes work in dev.
    proxy: Object.fromEntries(
      ["/proxy", "/list", "/session", "/ai", "/healthz"].map((path) => [path, "http://127.0.0.1:8765"]),
    ),
  },
}));
