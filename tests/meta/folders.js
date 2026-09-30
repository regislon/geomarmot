/* The transformer folders and their definitions, for the meta checks. */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export async function transformerFolders() {
  const out = [];
  for (const dir of readdirSync("transformers").sort()) {
    const path = join("transformers", dir);
    if (dir.startsWith("_") || !statSync(path).isDirectory()) continue;
    const module = await import(/* @vite-ignore */ resolve(path, "index.js"));
    out.push({
      dir,
      path,
      definition: module.default,
      readme: existsSync(join(path, "README.md")) ? readFileSync(join(path, "README.md"), "utf8") : null,
      testsPath: join(path, "tests.json"),
    });
  }
  return out;
}
