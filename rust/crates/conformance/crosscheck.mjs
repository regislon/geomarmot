// Replay the Rust comparator's verdicts (rust/target/crosscheck.json, written by
// `cargo test -p geomarmot-engine --test crosscheck`) through tests/harness/compare.js.
// Run from the repository root: node rust/crates/conformance/crosscheck.mjs
import { readFileSync } from "node:fs";
import { compareTable } from "../../../tests/harness/compare.js";

const records = JSON.parse(readFileSync(new URL("../../target/crosscheck.json", import.meta.url), "utf8"));
const disagree = [];
let rejected = 0;
for (const r of records) {
  let jsOk;
  try {
    jsOk = compareTable(r.actual, r.expected, { ordered: r.ordered, geometry: r.geometry }).length === 0;
  } catch {
    jsOk = false; // an unreadable geometry is a rejection
  }
  if (!jsOk) rejected++;
  if (jsOk !== r.rustOk)
    disagree.push(`${r.case}: compare.js ${jsOk ? "accepts" : "rejects"}, Rust ${r.rustOk ? "accepts" : "rejects"}`);
}
console.log(`${records.length} verdicts, ${rejected} rejections, ${disagree.length} disagreements`);
if (disagree.length) {
  console.log(disagree.join("\n"));
  process.exit(1);
}
