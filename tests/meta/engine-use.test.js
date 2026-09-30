/*
 * Hooks run SQL through ctx.engine only (docs/transformer-api.md): the same
 * hook runs in the main engine and in an isolated preview engine, so a
 * transformer that imports the main engine's exec/query would reach into the
 * user's database from a preview.
 */

import { test, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".js") ? [path] : [];
  });
}

test("no transformer or example runs SQL except through ctx.engine", () => {
  const offenders = [];
  for (const path of [...sources("transformers"), ...sources("examples")]) {
    const code = readFileSync(path, "utf8");
    if (/core\/duck\.js/.test(code) && /\b(exec|query|db|conn|readQuery)\b[^\n]*from "[^"]*core\/duck\.js"/.test(code))
      offenders.push(`${path}: imports the main engine`);
    for (const [index, line] of code.split("\n").entries()) {
      if (/(?<![\w.])(exec|query|readQuery)\(/.test(line) && !/^\s*(\*|\/\/)/.test(line))
        offenders.push(`${path}:${index + 1}: ${line.trim()}`);
    }
  }
  expect(offenders).toEqual([]);
});
