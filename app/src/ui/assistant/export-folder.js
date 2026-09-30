/*
 * "Export as folder": a generated transformer, written out as a transformer
 * folder a contributor can review and commit (transformers/<folder>/).
 *
 * The folder has index.js (the kit's defineTransformer, its steps composed as
 * CTEs through the same typed renderTemplate), README.md with the required
 * headings to fill in, and tests.json with one case built from the node's
 * current input: its first 20 rows, and what the steps make of them. It comes
 * as one .tar download. Only transformers made of SQL steps can be exported:
 * a call step is a node, not code.
 *
 * Nothing here leaves the browser; it is a download for the user.
 */

import { exec, qid, query } from "../../core/duck.js";
import { graph, incomingEdge } from "../../core/graph/index.js";
import { renderTemplate } from "../../core/template.js";
import { tarArchive } from "../../io/writers/tar.js";
import { retainShown } from "../compile-loop.js";

const SAMPLE = 20;
const AS_TEXT = /^(BIGINT|HUGEINT|UBIGINT|UHUGEINT|DATE|TIME.*|TIMESTAMP.*|DECIMAL.*|INTERVAL|UUID)$/;

/** Why a generated transformer cannot be exported, or null. */
export function exportBlocker(transformer) {
  if (!transformer?.generated) return "Only generated transformers can be exported as a folder.";
  if (transformer.generated.spec.steps.some((step) => step.kind !== "sql"))
    return "It has call steps, which are nodes rather than code: rebuild those as nodes in the graph.";
  return null;
}

const folderName = (id) => id.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/** The SQL of every output, with inputs given as relation names. */
function compose(spec, relationOf, params) {
  const specs = spec.params.map(({ id, kind }) => ({ id, kind }));
  const relation = (space, name) => (space === "inputs" ? relationOf(name) : `step_${name}`);
  const ctes = spec.steps
    .map((step) => `step_${step.id} AS (\n${renderTemplate(step.template, { relation, params, specs })}\n)`)
    .join(",\n");
  return Object.fromEntries(
    spec.outputs.map((output) => [output.id, `WITH ${ctes}\nSELECT * FROM step_${output.from.split(".")[1]}`]),
  );
}

function indexSource(spec) {
  const params = spec.params.map((p) => {
    const options = {
      description: p.description,
      ...(p.kind === "select" && { options: p.options.map((value) => ({ value, description: value })) }),
      ...(p.default_json?.trim() && { default: JSON.parse(p.default_json) }),
    };
    return `    param.${p.kind}(${JSON.stringify(p.id)}, ${JSON.stringify(p.label)}, ${JSON.stringify(options)}),`;
  });
  const steps = JSON.stringify(
    spec.steps.map(({ id, template }) => ({ id, template })),
    null,
    2,
  );
  const outputs = JSON.stringify(spec.outputs.map((o) => ({ id: o.id, step: o.from.split(".")[1] })));
  const specs = JSON.stringify(spec.params.map(({ id, kind }) => ({ id, kind })));
  return `// @ts-check
/*
 * ${spec.name || spec.id}: exported from a transformer the assistant generated.
 * Review the SQL, fill in the documentation (npm run check:docs), and check
 * tests.json before committing.
 */
import { defineTransformer, API_VERSION, param, renderTemplate } from "../_kit/index.js";

const STEPS = ${steps};
const OUTPUTS = ${outputs};
const PARAMS = ${specs};

export default defineTransformer({
  apiVersion: API_VERSION,
  id: ${JSON.stringify(spec.id)},
  name: ${JSON.stringify(spec.name || spec.id)},
  group: "Reshape",
  summary: ${JSON.stringify(spec.summary)},
  description: ${JSON.stringify(`${spec.description} TODO: describe how it works and what it does not do.`)},
  whenToUse: ["TODO"],
  whenNotToUse: ["TODO"],
  keywords: ["TODO"],
  examples: [{ input: "TODO", params: "TODO", output: "TODO" }],
  inputs: ${JSON.stringify(spec.inputs)},
  outputs: ${JSON.stringify(spec.outputs.map(({ id, label, description }) => ({ id, label, description })))},
  params: [
${params.join("\n")}
  ],
  sql: (ctx) => {
    // Steps are CTEs; every value goes in through renderTemplate, typed by its param's kind.
    const relation = (space, name) => (space === "inputs" ? ctx.inputs[name] : \`step_\${name}\`);
    const ctes = STEPS.map(
      (step) => \`step_\${step.id} AS (\\n\${renderTemplate(step.template, { relation, params: ctx.params, specs: PARAMS })}\\n)\`,
    ).join(",\\n");
    return Object.fromEntries(OUTPUTS.map((o) => [o.id, \`WITH \${ctes}\\nSELECT * FROM step_\${o.step}\`]));
  },
});
`;
}

function readme(spec) {
  const section = (title, body) => `## ${title}\n\n${body}\n`;
  return [
    `# ${spec.name || spec.id}\n`,
    section("What it does", `${spec.summary}\n\n${spec.description}`),
    section("When to use it", "TODO"),
    section("When not to use it", "TODO"),
    section(
      "Parameters",
      spec.params.map((p) => `- **${p.label}** (\`${p.id}\`, ${p.kind}): ${p.description}`).join("\n") || "None.",
    ),
    section("Output ports", spec.outputs.map((o) => `- **${o.label}** (\`${o.id}\`): ${o.description}`).join("\n")),
    section("Examples", "TODO"),
    section("Limitations", "TODO"),
    section("Credits", "Generated with the GeoMarmot assistant, then reviewed."),
  ].join("\n");
}

/** A relation's columns and rows in the fixture format: geometry as WKT, wide integers and dates as text. */
async function fixtureTable(relation) {
  const columns = (await query(`DESCRIBE SELECT * FROM ${relation}`)).map((row) => ({
    name: row.column_name,
    type: String(row.column_type).toUpperCase(),
  }));
  const select = columns
    .map(({ name, type }) =>
      type === "GEOMETRY"
        ? `ST_AsText(${qid(name)}) AS ${qid(name)}`
        : AS_TEXT.test(type)
          ? `${qid(name)}::VARCHAR AS ${qid(name)}`
          : type === "BLOB"
            ? `hex(${qid(name)}) AS ${qid(name)}`
            : qid(name),
    )
    .join(", ");
  const rows = await query(`SELECT ${select} FROM ${relation}`);
  return { columns, rows: rows.map((row) => columns.map((c) => row[c.name] ?? null)) };
}

async function testsJson(node, spec) {
  const lease = retainShown();
  const temps = [];
  try {
    const inputs = {};
    for (const port of spec.inputs) {
      const edge = incomingEdge(node.id, port.id, graph);
      const view = edge && lease.views.get(edge.from)?.[edge.fromPort];
      if (!view) throw new Error(`Connect "${port.label}" and let the graph compile first.`);
      const temp = `__export_${port.id}`;
      await exec(`CREATE OR REPLACE TEMP TABLE ${qid(temp)} AS SELECT * FROM ${view} LIMIT ${SAMPLE}`);
      temps.push(temp);
      inputs[port.id] = { crs: lease.crsByNode.get(edge.from) || "EPSG:4326", ...(await fixtureTable(qid(temp))) };
    }
    const expect = {};
    for (const [port, sql] of Object.entries(compose(spec, (name) => qid(`__export_${name}`), node.params))) {
      expect[port] = await fixtureTable(`(${sql})`);
    }
    return {
      transformer: spec.id,
      cases: [
        { name: `the first ${SAMPLE} rows of its input when it was exported`, params: node.params, inputs, expect },
      ],
    };
  } finally {
    for (const temp of temps) await exec(`DROP TABLE IF EXISTS ${qid(temp)}`).catch(() => {});
    lease.release();
  }
}

/** Build and download the folder for a node of a generated transformer. */
export async function exportAsFolder(node, transformer) {
  const blocker = exportBlocker(transformer);
  if (blocker) throw new Error(blocker);
  const spec = transformer.generated.spec;
  const folder = folderName(spec.id);
  const tests = await testsJson(node, spec);
  const blob = tarArchive([
    { name: `${folder}/index.js`, text: indexSource(spec) },
    { name: `${folder}/README.md`, text: readme(spec) },
    { name: `${folder}/tests.json`, text: `${JSON.stringify(tests, null, 2)}\n` },
  ]);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${folder}.tar`;
  anchor.click();
  URL.revokeObjectURL(url);
  return folder;
}
