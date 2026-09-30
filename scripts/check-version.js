/*
 * The release tag and every version in the repository must agree.
 *
 *   node scripts/check-version.js v0.1.0
 *
 * Checks package.json, server/pyproject.toml and server/geomarmot/__init__.py.
 */

import { readFileSync } from "node:fs";

const tag = process.argv[2] || "";
const wanted = tag.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:[-.]?(?:a|b|rc)\d+)?$/.test(wanted)) {
  console.error(`"${tag}" is not a release tag like v0.1.0.`);
  process.exit(1);
}
const found = {
  "package.json": JSON.parse(readFileSync("package.json", "utf8")).version,
  "server/pyproject.toml": readFileSync("server/pyproject.toml", "utf8").match(/^version = "([^"]+)"/m)?.[1],
  "server/geomarmot/__init__.py": readFileSync("server/geomarmot/__init__.py", "utf8").match(
    /__version__ = "([^"]+)"/,
  )?.[1],
};
const wrong = Object.entries(found).filter(([, version]) => version !== wanted);
if (wrong.length) {
  for (const [file, version] of wrong) console.error(`${file} says ${version ?? "(nothing)"}, the tag says ${wanted}.`);
  process.exit(1);
}
console.log(`All versions are ${wanted}.`);
