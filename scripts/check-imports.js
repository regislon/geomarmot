#!/usr/bin/env node
// Every relative import in maintained JavaScript points at a file that exists.
// (ESLint's no-undef catches missing names; this catches moved files.)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const files = execFileSync("git", [
  "ls-files",
  "-z",
  "-co",
  "--exclude-standard",
  "app",
  "transformers",
  "tests",
  "scripts",
])
  .toString()
  .split("\0")
  .filter((f) => f.endsWith(".js") && existsSync(f));
const problems = [];
for (const file of files) {
  // Import paths inside single-quoted strings or template literals (scaffold templates, test
  // expectations) are text, not imports.
  const source = readFileSync(file, "utf8")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
  for (const match of source.matchAll(
    /(?:\bfrom|\bimport)\s*\(?\s*"(\.{1,2}\/[^"]+)"|new URL\("(\.{1,2}\/[^"]+\.js)", import\.meta\.url\)/g,
  )) {
    const target = join(dirname(file), match[1] || match[2]);
    if (!existsSync(target)) problems.push(`${file}: "${match[1] || match[2]}" does not exist`);
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`check-imports: ${files.length} files, every relative import resolves.`);
