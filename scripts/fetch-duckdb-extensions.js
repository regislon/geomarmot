#!/usr/bin/env node
/*
 * Put the DuckDB extensions the app uses next to the build, so nothing is
 * fetched from a CDN at runtime (docs/decisions/0002-offline-bundle.md).
 *
 *   node scripts/fetch-duckdb-extensions.js            download what the lock lists, verify it
 *   node scripts/fetch-duckdb-extensions.js --update   re-derive version and platforms from the
 *                                                     installed bundles, rewrite the lock
 *
 * The lock (duckdb-extensions.lock.json) records the duckdb-wasm package version it was made
 * for, the DuckDB version and platforms that package's bundles report, and each file's size and
 * SHA-256. A lock made for another package version fails the build: upgrade on purpose, with
 * --update, and review the diff.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const LOCK = "duckdb-extensions.lock.json";
const OUT = "app/public/duckdb-extensions";
const REMOTE = "https://extensions.duckdb.org";
// spatial is loaded at boot; parquet and json are loaded explicitly right after, so that
// autoloading can be switched off.
const EXTENSIONS = ["spatial", "parquet", "json"];

const installed = JSON.parse(readFileSync("node_modules/@duckdb/duckdb-wasm/package.json", "utf8")).version;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function probeBundles() {
  // Boot each bundle in a real browser, through Vite so the package's own imports resolve.
  const { chromium } = await import("@playwright/test");
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: false,
    root: "scripts/duckdb-probe",
    logLevel: "silent",
    server: { port: 0, host: "127.0.0.1" },
    optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
  });
  await server.listen();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.probe);
  const found = await page.evaluate(() => window.probe());
  await browser.close();
  await server.close();
  const versions = [...new Set(found.map((f) => f.version))];
  if (versions.length !== 1) throw new Error(`Bundles disagree on the DuckDB version: ${versions.join(", ")}`);
  return { version: versions[0], platforms: found.map((f) => f.platform) };
}

async function download(path) {
  const response = await fetch(`${REMOTE}/${path}`);
  if (!response.ok) throw new Error(`${REMOTE}/${path}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function update() {
  const { version, platforms } = await probeBundles();
  const files = {};
  for (const platform of platforms) {
    for (const name of EXTENSIONS) {
      const path = `${version}/${platform}/${name}.duckdb_extension.wasm`;
      const bytes = await download(path);
      files[path] = { size: bytes.length, sha256: sha256(bytes) };
      mkdirSync(dirname(join(OUT, path)), { recursive: true });
      writeFileSync(join(OUT, path), bytes);
    }
  }
  writeFileSync(LOCK, JSON.stringify({ duckdbWasm: installed, duckdb: version, platforms, files }, null, 2) + "\n");
  console.log(`Locked ${Object.keys(files).length} extension files for DuckDB ${version} (${platforms.join(", ")}).`);
}

async function fetchLocked() {
  const lock = JSON.parse(readFileSync(LOCK, "utf8"));
  if (lock.duckdbWasm !== installed) {
    throw new Error(
      `${LOCK} was made for @duckdb/duckdb-wasm ${lock.duckdbWasm}, but ${installed} is installed. ` +
        "Run `node scripts/fetch-duckdb-extensions.js --update` and review the diff.",
    );
  }
  let fetched = 0;
  for (const [path, want] of Object.entries(lock.files)) {
    const target = join(OUT, path);
    let bytes = existsSync(target) ? readFileSync(target) : null;
    if (!bytes || sha256(bytes) !== want.sha256) {
      bytes = await download(path);
      fetched++;
    }
    if (bytes.length !== want.size || sha256(bytes) !== want.sha256) throw new Error(`${path}: checksum mismatch`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  console.log(`DuckDB extensions ready (${Object.keys(lock.files).length} files, ${fetched} downloaded).`);
}

try {
  await (process.argv.includes("--update") ? update() : fetchLocked());
} catch (err) {
  console.error(`fetch-duckdb-extensions: ${err.message}`);
  process.exit(1);
}
