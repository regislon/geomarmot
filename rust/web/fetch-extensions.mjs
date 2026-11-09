// Download the DuckDB-Wasm extensions the page loads, into public/extensions, and check them
// against extensions.lock.json (sizes and SHA-256). Run with --update to rewrite the lock.
// Nothing is fetched at runtime: the page serves these files itself (docs/decisions/0002).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const DUCKDB = "v1.5.4";
const PLATFORMS = ["wasm_eh", "wasm_mvp"];
const EXTENSIONS = ["spatial", "json"];
const here = dirname(new URL(import.meta.url).pathname);
const lockPath = join(here, "extensions.lock.json");
const update = process.argv.includes("--update");
const lock = update ? { duckdb: DUCKDB, files: {} } : JSON.parse(await readFile(lockPath, "utf8"));

for (const platform of PLATFORMS) {
  for (const name of EXTENSIONS) {
    const rel = `${DUCKDB}/${platform}/${name}.duckdb_extension.wasm`;
    const out = join(here, "public/extensions", rel);
    const have = await stat(out).catch(() => null);
    let bytes;
    if (have) bytes = await readFile(out);
    else {
      const res = await fetch(`https://extensions.duckdb.org/${rel}`);
      if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
      bytes = Buffer.from(await res.arrayBuffer());
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, bytes);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (update) lock.files[rel] = { size: bytes.length, sha256 };
    else if (lock.files[rel]?.sha256 !== sha256) throw new Error(`${rel}: does not match extensions.lock.json`);
    console.log(rel, bytes.length);
  }
}
if (update) await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
