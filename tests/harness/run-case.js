/*
 * Running one fixture case through HarnessApi, from Node (Playwright).
 *
 * A case feeds its inputs either as typed tables through FixtureSource nodes
 * (the usual way, which can carry any CRS), or as a real source file through a
 * Reader (for behaviour that depends on the file itself: H3 defaults from the
 * file name, the Reader's row number and CRS handling).
 */

import { compareTable } from "./compare.js";

const INPUT_PORT_DEFAULT = "input";

let tableCounter = 0;

/**
 * Build and compile the case's graph; return what each port produced.
 * @param {import("@playwright/test").Page} page
 * @param {string} type transformer type (the name used by the app under test)
 * @param {object} testCase
 */
export async function runCase(page, type, testCase) {
  return page.evaluate(
    async ({ type, testCase, counter }) => {
      const h = window.__geomarmotHarness;
      const nodes = [];
      const edges = [];
      if (testCase.source) {
        const src = testCase.source;
        const table = `fx_src_${counter}`;
        await h.createTable(table, src.columns, src.rows);
        const bytes = await h.tableToParquet(table);
        const made = await h.loadSourceFile(src.fileName, bytes);
        nodes.push({ key: "reader", type: "Reader", params: { sourceId: made[0].id, ...(src.readerParams || {}) } });
        if (type !== "Reader") {
          nodes.push({ key: "subject", type, params: testCase.params || {} });
          edges.push({ from: "reader", fromPort: "output", to: "subject", toPort: src.port || "input" });
        } else {
          nodes[0].key = "subject";
          Object.assign(nodes[0].params, testCase.params || {});
        }
      } else {
        nodes.push({ key: "subject", type, params: testCase.params || {} });
        let k = 0;
        for (const [port, input] of Object.entries(testCase.inputs || {})) {
          const table = `fx_${counter}_${k++}`;
          await h.createTable(table, input.columns, input.rows);
          nodes.push({ key: `in_${port}`, type: "FixtureSource", params: { table, crs: input.crs || "EPSG:4326" } });
          edges.push({ from: `in_${port}`, fromPort: "output", to: "subject", toPort: port });
        }
      }
      if (testCase.sink) {
        // A sink: compile its input, run the writer, and read what it wrote.
        const feeder = nodes.find((n) => n.key.startsWith("in_"));
        const ids = h.buildGraph([feeder], []);
        const compiled = await h.compile();
        const view = compiled.views[ids[feeder.key]].output;
        const p = { format: "Parquet", filename: "output", ...(testCase.params || {}) };
        const written = await h.runWriter(view, p.format, p.filename, feeder.params.crs || "EPSG:4326");
        const file = written.files[0];
        const out = { error: null, ports: {}, file: null, note: written.note };
        if (file) {
          const text = new TextDecoder().decode(new Uint8Array(file.bytes));
          out.file = { name: file.name, text: /\.(csv|geojson|json)$/.test(file.name) ? text : null };
          if (!out.file.text) {
            const made = await h.loadSourceFile(file.name, file.bytes);
            const back = h.buildGraph([{ key: "r", type: "Reader", params: { sourceId: made[0].id } }], []);
            const reread = await h.compile();
            out.file.table = await h.readPort(reread.views[back.r].output);
          }
        }
        await h.teardown();
        return out;
      }
      const ids = h.buildGraph(nodes, edges);
      const compiled = await h.compile();
      const subject = ids.subject;
      const out = { error: null, ports: {}, crs: compiled.crs[subject] ?? null };
      if (compiled.error) {
        out.error = { message: compiled.error.message, atSubject: compiled.error.nodeId === subject };
        await h.teardown();
        return out;
      }
      for (const [port, view] of Object.entries(compiled.views[subject] || {}))
        out.ports[port] = await h.readPort(view);
      await h.teardown();
      return out;
    },
    { type, testCase, counter: ++tableCounter },
  );
}

/** Check invariants for cases whose rows cannot be predicted exactly (random sampling). */
function checkAssertions(result, testCase) {
  const problems = [];
  const a = testCase.assert;
  const port = a.port || "output";
  const table = result.ports[port];
  if (!table) return [`no "${port}" port`];
  const input = testCase.inputs?.[INPUT_PORT_DEFAULT];
  if (a.rowCount) {
    const n = table.rows.length;
    if ((a.rowCount.min ?? -Infinity) > n || (a.rowCount.max ?? Infinity) < n) {
      problems.push(`${n} rows, expected between ${a.rowCount.min} and ${a.rowCount.max}`);
    }
  }
  if (a.columnsEqual === "input" && input) {
    const got = table.columns.map((c) => `${c.name} ${c.type}`).join(", ");
    const want = input.columns.map((c) => `${c.name} ${c.type}`).join(", ");
    if (got !== want) problems.push(`columns ${got} ≠ input's ${want}`);
  }
  if (a.subsetOf === "input" && input) {
    const pool = input.rows.map((r) => JSON.stringify(r));
    for (const row of table.rows) {
      const at = pool.indexOf(JSON.stringify(row));
      if (at < 0) problems.push(`row ${JSON.stringify(row)} is not an input row`);
      else pool.splice(at, 1);
    }
  }
  for (const columns of a.unique ? [a.unique] : []) {
    const idx = columns.map((name) => table.columns.findIndex((c) => c.name === name));
    const keys = table.rows.map((row) => JSON.stringify(idx.map((k) => row[k])));
    if (new Set(keys).size !== keys.length) problems.push(`rows are not unique on ${columns.join(", ")}`);
  }
  return problems;
}

/** Compare a run with the case's expectation; returns a list of problems. */
export function checkCase(result, testCase) {
  const problems = [];
  if (testCase.expect?.error !== undefined) {
    if (!result.error) problems.push(`expected an error containing "${testCase.expect.error}", got none`);
    else if (!result.error.message.includes(testCase.expect.error)) {
      problems.push(`error "${result.error.message}" does not contain "${testCase.expect.error}"`);
    }
    return problems;
  }
  if (result.error) return [`unexpected error: ${result.error.message}`];
  if (testCase.assert) return checkAssertions(result, testCase);
  if (testCase.sink) {
    const want = testCase.expect.file;
    if (!result.file) return ["the writer produced no file"];
    if (want.name && result.file.name !== want.name) problems.push(`file ${result.file.name}, expected ${want.name}`);
    if (want.text !== undefined && result.file.text !== want.text)
      problems.push(`text ${JSON.stringify(result.file.text)} ≠ ${JSON.stringify(want.text)}`);
    if (want.json !== undefined && JSON.stringify(JSON.parse(result.file.text)) !== JSON.stringify(want.json)) {
      problems.push(`json ${result.file.text} ≠ ${JSON.stringify(want.json)}`);
    }
    if (want.table)
      for (const p of compareTable(result.file.table, want.table, { geometry: testCase.geometry || {} }))
        problems.push(`file: ${p}`);
    if (want.note !== undefined && !(result.note || "").includes(want.note))
      problems.push(`note "${result.note}" does not contain "${want.note}"`);
    return problems;
  }
  for (const [port, expected] of Object.entries(testCase.expect || {})) {
    if (port === "crs") continue;
    const actual = result.ports[port];
    if (!actual) {
      problems.push(`no "${port}" port in the output (have: ${Object.keys(result.ports).join(", ")})`);
      continue;
    }
    for (const p of compareTable(actual, expected, { ordered: testCase.ordered, geometry: testCase.geometry || {} })) {
      problems.push(`${port}: ${p}`);
    }
  }
  if (testCase.expect?.crs && testCase.expect.crs !== result.crs) {
    problems.push(`output CRS ${result.crs}, expected ${testCase.expect.crs}`);
  }
  return problems;
}
