/*
 * npm run eval — run evals/cases.json against a real model, through the real
 * app in Chromium, and report which drafts contain what they should.
 *
 * Needs ANTHROPIC_API_KEY (it is typed into the page's settings, as a user
 * would) and spends real tokens: a handful of short conversations per run.
 * Not part of CI. Options: --only <name fragment>, --model <id>.
 */

import { chromium } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { serve } from "../tests/harness/serve.js";

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error("Set ANTHROPIC_API_KEY to run the evals (they call the real API and cost tokens).");
  process.exit(2);
}
if (!existsSync("dist/index.html")) {
  console.error("Build first: npm run build");
  process.exit(2);
}
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const only = arg("--only");
const model = arg("--model");
const { cases } = JSON.parse(readFileSync("evals/cases.json", "utf8"));

const at = (value, path) => path.split(".").reduce((v, part) => (v == null ? v : v[part]), value);

async function runCase(browser, server, c) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${server.url}/`);
    await page.waitForFunction(
      () => /Drop a file|nodes ready/.test(document.getElementById("status")?.textContent || ""),
      null,
      { timeout: 90_000 },
    );
    await page.setInputFiles("#file-input", { name: "data.csv", mimeType: "text/csv", buffer: Buffer.from(c.csv) });
    await page.waitForFunction(() => /rows/.test(document.getElementById("status")?.textContent || ""));
    await page.click("#btn-assistant");
    await page.click("#assistant-settings");
    if (model) await page.selectOption("#ai-settings-body select", model);
    await page.fill("#ai-key", key);
    await page.check(`input[name="ai-level"][value="${c.level}"]`);
    await page.click("#ai-settings-save");
    await page.fill("#assistant-input", c.prompt);
    await page.click("#assistant-send");
    await page.waitForFunction(() => !document.getElementById("assistant-send").disabled, null, { timeout: 180_000 });
    const reply = await page.locator("#assistant-log").innerText();
    if (!(await page.locator("#draft-apply").count())) return { ok: false, why: "no draft", reply };
    await page.click("#draft-apply");
    const graph = JSON.parse(await page.evaluate(() => localStorage.getItem("geomarmot:graph.v1")));
    const misses = [];
    for (const want of c.expect) {
      const node = graph.nodes.find(
        (n) =>
          n.type === want.type &&
          Object.entries(want.params || {}).every(([path, value]) => at(n.params, path) === value),
      );
      if (!node) misses.push(`${want.type}${want.params ? ` ${JSON.stringify(want.params)}` : ""}`);
    }
    return {
      ok: !misses.length,
      why: misses.length ? `missing ${misses.join("; ")}` : "",
      nodes: graph.nodes.map((n) => n.type),
    };
  } finally {
    await context.close();
  }
}

const server = await serve({ root: "dist" });
const browser = await chromium.launch();
let passed = 0;
const selected = cases.filter((c) => !only || c.name.includes(only));
try {
  for (const c of selected) {
    const started = Date.now();
    let result;
    try {
      result = await runCase(browser, server, c);
    } catch (err) {
      result = { ok: false, why: err.message.split("\n")[0] };
    }
    if (result.ok) passed += 1;
    const seconds = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`${result.ok ? "pass" : "FAIL"}  ${c.name} (${seconds} s)${result.ok ? "" : ` — ${result.why}`}`);
    if (result.nodes) console.log(`      nodes: ${result.nodes.join(" → ")}`);
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${passed} of ${selected.length} cases passed.`);
process.exit(passed === selected.length ? 0 : 1);
