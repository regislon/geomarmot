#!/usr/bin/env node
/*
 * The 400-line rule, for maintained source files only.
 *
 * Lockfiles, JSON, generated schemas, fixtures and Markdown are not code
 * anyone edits by hand, so they are out of scope. Exceptions live in
 * scripts/size-exceptions.json, each naming the milestone that removes it; an
 * exception that is no longer needed fails the check, so the list stays honest.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const LIMIT = 400;
const IN_SCOPE = [
  /^app\/src\/.*\.(js|css)$/,
  /^app\/testing\/.*\.js$/,
  /^transformers\/.*\.js$/,
  /^scripts\/.*\.js$/,
  /^server\/geomarmot\/.*\.py$/,
  /^tests\/.*\.js$/,
];

const exceptions = existsSync("scripts/size-exceptions.json")
  ? JSON.parse(readFileSync("scripts/size-exceptions.json", "utf8"))
  : {};
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
  .toString()
  .split("\0")
  .filter((path) => path && IN_SCOPE.some((re) => re.test(path)) && existsSync(path));

const problems = [];
for (const path of files) {
  const lines = readFileSync(path, "utf8").split("\n").length;
  const exception = exceptions[path];
  if (lines > LIMIT && !exception) problems.push(`${path}: ${lines} lines (limit ${LIMIT})`);
  if (exception && lines <= LIMIT) problems.push(`${path}: exception no longer needed (${lines} lines); remove it`);
}
for (const [path, exception] of Object.entries(exceptions)) {
  if (!exception.until) problems.push(`${path}: exception must name the milestone that removes it ("until")`);
  if (!files.includes(path)) problems.push(`${path}: exception for a file that does not exist; remove it`);
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`check-size: ${files.length} source files within ${LIMIT} lines.`);
