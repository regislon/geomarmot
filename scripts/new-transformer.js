#!/usr/bin/env node
/*
 * Scaffold a transformer folder:  npm run new-transformer -- MyThing [--group Geometry]
 *
 * Creates transformers/my-thing/{index.js,README.md,tests.json} from templates
 * whose guidance comments `npm run check:docs` refuses until they are replaced,
 * and adds the import line to transformers/index.js in its group. Then: write
 * tests.json first, implement index.js, fill in the README.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const GROUPS = ["Source", "Attributes", "Filters", "Combine", "Reshape", "Geometry", "Analysis", "H3", "Output"];
const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--group");
const group = args.includes("--group") ? args[args.indexOf("--group") + 1] : "Reshape";

if (!id || !/^[A-Z][A-Za-z0-9]*$/.test(id)) {
  console.error("Usage: npm run new-transformer -- MyThing [--group Geometry]   (a PascalCase id)");
  process.exit(2);
}
if (!GROUPS.includes(group)) {
  console.error(`--group must be one of ${GROUPS.join(", ")}`);
  process.exit(2);
}
const folder = id
  .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
  .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
  .toLowerCase();
const dir = `transformers/${folder}`;
if (existsSync(dir)) {
  console.error(`${dir} already exists.`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

writeFileSync(
  `${dir}/index.js`,
  `// @ts-check
import { defineTransformer, API_VERSION, param, SINGLE_IN, qid } from "../_kit/index.js";

/*
 * Read docs/transformer-api.md and one of examples/ first, and write tests.json
 * before this file. Prefer pure SQL; add prepare() only for work DuckDB cannot do.
 */
export default defineTransformer({
  apiVersion: API_VERSION,
  id: "${id}",
  group: "${group}",
  summary: "<!-- guidance: one sentence, 20-160 characters, saying what it produces -->",
  description: "<!-- guidance: at least 60 words — what it does, how, and what it does not do -->",
  whenToUse: ["<!-- guidance: a situation, phrased as a user would ask -->", "<!-- guidance: another -->"],
  whenNotToUse: ["<!-- guidance: a situation, naming the transformer to use instead -->"],
  keywords: ["<!-- guidance: at least three, with synonyms users might type -->"],
  examples: [{ input: "<!-- guidance -->", params: "<!-- guidance -->", output: "<!-- guidance -->" }],
  inputs: SINGLE_IN,
  outputs: [{ id: "output", label: "Output", description: "<!-- guidance: what arrives on this port -->" }],
  params: [
    param.column("column", "Attribute", { description: "<!-- guidance: at least ten words, with units where they apply -->" }),
  ],
  sql: (ctx) => ({ output: \`SELECT * FROM \${ctx.inputs.input} WHERE \${qid(ctx.params.column || "id")} IS NOT NULL\` }),
});
`,
);

writeFileSync(
  `${dir}/README.md`,
  `# ${id}

<!-- guidance: one line saying what it produces -->

## What it does

<!-- guidance: how it works, with a table where the behaviour has cases -->

## When to use it

<!-- guidance: two or more concrete situations -->

## When not to use it

<!-- guidance: at least one, naming the transformer to use instead -->

## Parameters

<!-- guidance: a table, one row per parameter, with units -->

## Output ports

<!-- guidance: a table, one row per port, including why rows go to a rejected port -->

## Examples

<!-- guidance: input → parameters → output; a fixture can double as one -->

## Limitations

<!-- guidance: what it does not do, and its ceilings -->

## Credits

<!-- guidance: libraries and algorithms it relies on -->
`,
);

writeFileSync(
  `${dir}/tests.json`,
  JSON.stringify(
    {
      transformer: id,
      cases: [
        {
          name: "<!-- guidance: what this case shows -->",
          params: { column: "name" },
          inputs: {
            input: {
              columns: [
                { name: "id", type: "INTEGER" },
                { name: "name", type: "VARCHAR" },
              ],
              rows: [
                [1, "a"],
                [2, null],
              ],
            },
          },
          expect: {
            output: {
              columns: [
                { name: "id", type: "INTEGER" },
                { name: "name", type: "VARCHAR" },
              ],
              rows: [[1, "a"]],
            },
          },
        },
      ],
    },
    null,
    2,
  ) + "\n",
);

// Register: one import line inside the group's block, alphabetical, and the NATIVE list.
const indexPath = "transformers/index.js";
let index = readFileSync(indexPath, "utf8");
const marker = `// ${group}\n`;
if (!index.includes(marker)) index = index.replace("\nconst NATIVE = [", `\n${marker}\nconst NATIVE = [`);
const start = index.indexOf(marker) + marker.length;
let end = start;
const lines = [];
while (index.startsWith("import ", end)) {
  const nl = index.indexOf("\n", end) + 1;
  lines.push(index.slice(end, nl));
  end = nl;
}
lines.push(`import ${id} from "./${folder}/index.js";\n`);
lines.sort();
index = index.slice(0, start) + lines.join("") + index.slice(end);
index = index.replace("const NATIVE = [\n", `const NATIVE = [\n  ${id},\n`);
writeFileSync(indexPath, index);

console.log(`Created ${dir}/ and registered ${id} in ${group}.
Next: write ${dir}/tests.json first, then index.js, then README.md; run npm run check and npm run test:browser.`);
