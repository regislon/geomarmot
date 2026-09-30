/*
 * check:docs — every transformer is described in detail (PLAN.md §3, docs/params.md).
 * The description is read by users (the ? panel), the assistant (its catalogue)
 * and coding agents, so it is part of the contract.
 */

import { describe, test, expect } from "vitest";
import { transformerFolders } from "./folders.js";

const HEADINGS = [
  "What it does",
  "When to use it",
  "When not to use it",
  "Parameters",
  "Output ports",
  "Examples",
  "Limitations",
  "Credits",
];
const words = (text) =>
  String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
const PLACEHOLDER = /\b(TODO|TBD|FIXME|lorem ipsum)\b|<!--\s*guidance/i;

function metadataProblems(t) {
  const p = [];
  const len = t.summary.length;
  if (len < 20 || len > 160) p.push(`summary is ${len} characters; it must be 20–160`);
  if (words(t.description) < 60) p.push(`description has ${words(t.description)} words; it needs at least 60`);
  if (new RegExp(`^\\s*${t.id}\\s+\\w+s\\b`, "i").test(t.description) && words(t.description) < 70)
    p.push("description only restates the name");
  if (t.whenToUse.length < 2) p.push("whenToUse needs at least 2 situations");
  if (t.whenNotToUse.length < 1) p.push("whenNotToUse needs at least 1 situation");
  if (t.keywords.length < 3) p.push("keywords needs at least 3 entries");
  if (t.examples.length < 1) p.push("examples needs at least 1 worked example");
  for (const text of [t.summary, t.description, ...t.whenToUse, ...t.whenNotToUse])
    if (PLACEHOLDER.test(text)) p.push(`placeholder text: "${text.slice(0, 40)}"`);
  for (const param of t.params) {
    if (words(param.description) < 10) p.push(`param ${param.id}: description needs at least 10 words`);
    if ((param.description || "").trim().toLowerCase() === param.label.trim().toLowerCase())
      p.push(`param ${param.id}: description repeats the label`);
    if (param.kind === "select" && Array.isArray(param.options)) {
      for (const option of param.options) {
        if (typeof option === "string" || !option.description)
          p.push(
            `param ${param.id}: option "${typeof option === "string" ? option : option.value}" needs a description`,
          );
      }
    }
  }
  const ports = [...t.inputs, ...(typeof t.outputsFor === "function" ? t.outputsFor({}) : [])];
  for (const port of ports) if (!port.description) p.push(`port ${port.id}: needs a description`);
  return p;
}

function readmeProblems(readme) {
  if (!readme) return ["README.md is missing"];
  const p = [];
  const found = [...readme.matchAll(/^## (.+)$/gm)].map((m) => ({ title: m[1].trim(), index: m.index }));
  const titles = found.map((f) => f.title);
  if (JSON.stringify(titles) !== JSON.stringify(HEADINGS))
    p.push(`headings must be, in order: ${HEADINGS.join(" · ")} (found: ${titles.join(" · ")})`);
  found.forEach((f, i) => {
    const body = readme.slice(f.index + f.title.length + 3, found[i + 1]?.index ?? readme.length).trim();
    if (!body) p.push(`"${f.title}" is empty`);
    if (PLACEHOLDER.test(body)) p.push(`"${f.title}" has placeholder text`);
  });
  return p;
}

const folders = await transformerFolders();
describe("transformer documentation", () => {
  for (const f of folders) {
    test(f.dir, () => {
      expect([...metadataProblems(f.definition), ...readmeProblems(f.readme)]).toEqual([]);
    });
  }
});
