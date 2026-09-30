import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("new-transformer scaffolds a folder and registers it in its group, alphabetically", () => {
  const dir = mkdtempSync(join(tmpdir(), "scaffold-"));
  cpSync("transformers/index.js", join(dir, "transformers/index.js"), { recursive: true });
  execFileSync("node", [resolve("scripts/new-transformer.js"), "AaaProbe", "--group", "Filters"], { cwd: dir });
  for (const file of ["index.js", "README.md", "tests.json"])
    expect(existsSync(join(dir, "transformers/aaa-probe", file))).toBe(true);
  const index = readFileSync(join(dir, "transformers/index.js"), "utf8");
  const block = index.slice(index.indexOf("// Filters\n")).split("\n\n")[0];
  expect(block.split("\n")[1]).toBe('import AaaProbe from "./aaa-probe/index.js";');
  expect(index).toMatch(/const NATIVE = \[\n {2}AaaProbe,/);
  expect(() =>
    execFileSync("node", [resolve("scripts/new-transformer.js"), "AaaProbe"], { cwd: dir, stdio: "pipe" }),
  ).toThrow();
  expect(() =>
    execFileSync("node", [resolve("scripts/new-transformer.js"), "not-pascal"], { cwd: dir, stdio: "pipe" }),
  ).toThrow();
});
