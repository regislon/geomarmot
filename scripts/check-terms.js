#!/usr/bin/env node
/*
 * Forbidden-terms gate.
 *
 *   --tree               every tracked file: path and content
 *   --staged             each staged path and its staged content (pre-commit)
 *   --history <range>    each commit in the range: message, identities, paths, added lines
 *   --history --all      every commit reachable from HEAD, root commit included
 *   --text               text on stdin (PR titles and bodies in CI)
 *   --hash               regenerate the hash file from .local/forbidden-terms.txt
 *
 * Options: --list <file> to use another hash file (tests), --cwd <dir>.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { buildHashFile, isBinary, parseHashFile, scanText } from "./terms/lib.js";

const EXCLUDED = [
  /^node_modules\//,
  /^dist(-test)?\//,
  /^server\/geomarmot\/static\//,
  /^\.local\//,
  /^test-results\//,
];
const BINARY_ALLOWED = [/^docs\/img\/[^/]+\.png$/, /^app\/public\/[^/]+\.(svg|png)$/];

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const cwd = option("--cwd") || process.cwd();
const listPath = option("--list") || join(cwd, "scripts/forbidden-terms.sha256");

function git(...gitArgs) {
  return execFileSync("git", gitArgs, { cwd, maxBuffer: 1 << 30 });
}

function loadList() {
  return parseHashFile(readFileSync(listPath, "utf8"));
}

/** Text chunks of a PNG (tEXt, iTXt, zTXt keywords and values), for scanning. */
function pngText(buffer) {
  const texts = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    if (["tEXt", "iTXt", "zTXt", "eXIf"].includes(type)) {
      texts.push(buffer.toString("latin1", offset + 8, offset + 8 + length).replace(/\0/g, " "));
    }
    offset += 12 + length;
  }
  return texts.join("\n");
}

const problems = [];
function report(where, hits) {
  for (const hit of hits)
    problems.push(`${where}${hit.line ? `:${hit.line}` : ""} matches a forbidden term ("${hit.match}")`);
}

/** Scan one file's path and bytes. */
function scanFile(path, buffer, list) {
  if (EXCLUDED.some((re) => re.test(path))) return;
  report(
    `${path} (path)`,
    scanText(path, list).map((h) => ({ ...h, line: 0 })),
  );
  if (isBinary(buffer)) {
    if (!BINARY_ALLOWED.some((re) => re.test(path))) {
      problems.push(`${path} is a binary file outside the allowlist (generate fixtures at test time)`);
      return;
    }
    if (path.endsWith(".png")) report(`${path} (metadata)`, scanText(pngText(buffer), list));
    return;
  }
  report(path, scanText(buffer.toString("utf8"), list));
}

function scanTree(list) {
  const files = git("ls-files", "-z").toString().split("\0").filter(Boolean);
  for (const path of files) {
    const full = join(cwd, path);
    if (!existsSync(full)) continue;
    scanFile(path, readFileSync(full), list);
  }
}

function scanStaged(list) {
  const files = git("diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR")
    .toString()
    .split("\0")
    .filter(Boolean);
  for (const path of files) scanFile(path, git("show", `:${path}`), list);
}

function scanCommit(sha, list) {
  const meta = git("show", "-s", "--format=%an%n%ae%n%cn%n%ce%n%B", sha).toString();
  report(`commit ${sha.slice(0, 10)} (message/identity)`, scanText(meta, list));
  // --root makes the root commit show its whole content as additions.
  const diff = git("show", "--root", "--format=", "--no-color", "--unified=0", "--no-ext-diff", "-M", sha).toString();
  for (const line of diff.split("\n")) {
    let text = null;
    if (line.startsWith("+++ b/")) text = line.slice(6);
    else if (line.startsWith("rename to ")) text = line.slice(10);
    else if (line.startsWith("+") && !line.startsWith("+++")) text = line.slice(1);
    else if (line.startsWith("Binary files")) text = line;
    if (text !== null)
      report(
        `commit ${sha.slice(0, 10)}`,
        scanText(text, list).map((h) => ({ ...h, line: 0 })),
      );
  }
}

function scanHistory(list) {
  const range = option("--history");
  const shas =
    args.includes("--all") || range === "--all"
      ? git("rev-list", "HEAD").toString().split("\n").filter(Boolean)
      : git("rev-list", range).toString().split("\n").filter(Boolean);
  for (const sha of shas) scanCommit(sha, list);
  return shas.length;
}

function regenerate() {
  const plain = join(cwd, ".local/forbidden-terms.txt");
  if (!existsSync(plain)) throw new Error("No .local/forbidden-terms.txt to hash.");
  const terms = readFileSync(plain, "utf8")
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => t && !t.startsWith("#"));
  const salt = existsSync(listPath)
    ? parseHashFile(readFileSync(listPath, "utf8")).salt
    : randomBytes(16).toString("hex");
  writeFileSync(listPath, buildHashFile(salt, terms));
  console.log(`Wrote ${terms.length} terms to ${listPath}.`);
}

try {
  if (args.includes("--hash")) {
    regenerate();
    process.exit(0);
  }
  const list = loadList();
  let scope = "";
  if (args.includes("--tree")) {
    scanTree(list);
    scope = "tracked files";
  } else if (args.includes("--staged")) {
    scanStaged(list);
    scope = "staged files";
  } else if (args.includes("--history")) {
    scope = `${scanHistory(list)} commits`;
  } else if (args.includes("--text")) {
    report("stdin", scanText(readFileSync(0, "utf8"), list));
    scope = "text";
  } else {
    throw new Error("Choose one of --tree, --staged, --history <range>|--all, --text, --hash.");
  }
  if (problems.length) {
    console.error(problems.join("\n"));
    console.error(`\ncheck-terms: ${problems.length} problem(s) in ${scope}.`);
    process.exit(1);
  }
  console.log(`check-terms: ${scope} are clean.`);
} catch (err) {
  console.error(`check-terms: ${err.message}`);
  process.exit(2);
}
