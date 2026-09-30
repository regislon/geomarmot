/*
 * check:fixtures — the rules every transformer's tests.json must meet (PLAN.md §3).
 * Whether the cases pass is the browser fixture suite's job; this checks their shape.
 */

import { describe, test, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { defaultParamValues, optionValues } from "../../transformers/_kit/index.js";
import { transformerFolders } from "./folders.js";

const MAX_BYTES = 50 * 1024;
const MAX_ROWS = 50;
// Uncovered select options warn until v0.2, then fail.
const OPTIONS_FAIL = false;

function problems(f) {
  const out = [];
  const warnings = [];
  if (!existsSync(f.testsPath)) return { out: ["tests.json is missing"], warnings };
  const size = statSync(f.testsPath).size;
  if (size > MAX_BYTES) out.push(`tests.json is ${size} bytes; the limit is ${MAX_BYTES}`);
  const suite = JSON.parse(readFileSync(f.testsPath, "utf8"));
  const t = f.definition;
  if (suite.transformer !== t.id) out.push(`tests.json names "${suite.transformer}", the folder defines "${t.id}"`);
  if (!suite.cases?.length) return { out: [...out, "tests.json has no cases"], warnings };
  const exercised = new Set();
  const allPorts = new Set();
  const optionsSeen = new Map();
  for (const c of suite.cases) {
    const params = { ...defaultParamValues(t.params), ...(c.params || {}) };
    for (const port of t.outputsFor(params)) allPorts.add(port.id);
    for (const port of Object.keys(c.expect || {})) if (port !== "crs" && port !== "error") exercised.add(port);
    if (c.assert) exercised.add(c.assert.port || "output");
    for (const [port, input] of Object.entries(c.inputs || {})) {
      if ((input.rows || []).length > MAX_ROWS)
        out.push(`${c.name}: ${input.rows.length} rows on ${port}; the limit is ${MAX_ROWS}`);
    }
    if (c.source && c.source.rows.length > MAX_ROWS)
      out.push(`${c.name}: ${c.source.rows.length} source rows; the limit is ${MAX_ROWS}`);
    if (c.geometry?.ignore?.length && !c.geometry.why) out.push(`${c.name}: geometry.ignore needs a "why"`);
    if (!c.expect && !c.assert) out.push(`${c.name}: no expect and no assert`);
    for (const p of t.params)
      if (p.kind === "select") {
        if (!optionsSeen.has(p.id)) optionsSeen.set(p.id, new Set());
        optionsSeen.get(p.id).add(String(params[p.id]));
      }
  }
  if (t.role !== "sink")
    for (const port of allPorts) if (!exercised.has(port)) out.push(`output port "${port}" is never exercised`);
  for (const p of t.params) {
    // Levels (resolutions, sample steps, passes) need one case, not one per value.
    if (p.kind !== "select" || !Array.isArray(p.options) || p.coverage === "one") continue;
    const missing = optionValues(p).filter((v) => !optionsSeen.get(p.id)?.has(String(v)));
    if (missing.length)
      (OPTIONS_FAIL ? out : warnings).push(`param ${p.id}: no case for ${missing.map((m) => `"${m}"`).join(", ")}`);
  }
  return { out, warnings };
}

const folders = await transformerFolders();
describe("transformer fixtures", () => {
  for (const f of folders) {
    test(f.dir, () => {
      const { out, warnings } = problems(f);
      for (const w of warnings) console.warn(`${f.dir}: ${w}`);
      expect(out).toEqual([]);
    });
  }
});
