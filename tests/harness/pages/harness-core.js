/*
 * HarnessApi v1, implemented on top of an app's own modules.
 *
 * The bundle's test entry builds this object from the modules the production
 * entry uses. The case runner only ever talks to this interface (see ../api.md).
 *
 * `mods` = { duck, graph, registry, sources, writer }:
 *   duck      boot, query, exec, qid, qlit, db
 *   graph     clear, addNode, addEdge, compile, nodeById
 *   registry  { register(type, transformer), defaultParams(type) }
 *   sources   { sources: Map, addLocalFile(File) }
 *   writer    runWriter(view, format, fileName, { crs })
 */

export const HARNESS_API_VERSION = 1;

/** SELECT list that turns a port's columns into JSON-safe, comparable values. */
function readableColumn(qid, column) {
  const name = qid(column.name);
  const type = column.type;
  if (type === "GEOMETRY") return `ST_AsText(${name}) AS ${name}`;
  if (type === "WKB_BLOB") return `ST_AsText(ST_GeomFromWKB(${name})) AS ${name}`;
  if (type === "BLOB") return `hex(${name}) AS ${name}`;
  // 64-bit and wider integers go as text, so an H3 index survives exactly.
  if (/^(BIGINT|UBIGINT|HUGEINT|UHUGEINT)$/.test(type)) return `${name}::VARCHAR AS ${name}`;
  if (/^DECIMAL/.test(type)) return `${name}::DOUBLE AS ${name}`;
  if (/^(DATE|TIME|TIMESTAMP|INTERVAL)/.test(type)) return `${name}::VARCHAR AS ${name}`;
  if (/(\[\]$|^STRUCT|^MAP|^UNION)/.test(type)) return `to_json(${name})::VARCHAR AS ${name}`;
  return name;
}

function typedLiteral(qlit, value, type) {
  if (value === null || value === undefined) return `NULL::${type === "GEOMETRY" ? "GEOMETRY" : type}`;
  if (type === "GEOMETRY") return `ST_GeomFromText(${qlit(value)})`;
  if (typeof value === "object") return `CAST(${qlit(JSON.stringify(value))} AS ${type})`;
  return `CAST(${qlit(String(value))} AS ${type})`;
}

export function createHarness(mods) {
  const { duck, graph, registry, sources, writer } = mods;
  const tables = new Set();
  const downloads = [];

  // The writers hand their bytes to a download; capture them instead.
  const createObjectURL = URL.createObjectURL.bind(URL);
  const blobs = new Map();
  URL.createObjectURL = (blob) => {
    const url = createObjectURL(blob);
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function click() {
    const blob = blobs.get(this.href);
    if (blob) downloads.push({ name: this.download, blob });
  };

  const api = {
    version: HARNESS_API_VERSION,

    async boot() {
      await duck.boot();
      return true;
    },

    registerFixtureSource() {
      registry.register("FixtureSource", {
        label: "FixtureSource",
        group: "Test",
        inputs: [],
        outputs: () => [{ id: "output", label: "Output" }],
        params: [],
        sql: (node) => ({ output: `SELECT * FROM ${duck.qid(node.params.table)}` }),
        crs: (node) => node.params.crs || "EPSG:4326",
      });
    },

    async createTable(name, columns, rows) {
      const defs = columns.map((c) => `${duck.qid(c.name)} ${c.type}`).join(", ");
      await duck.exec(`CREATE OR REPLACE TABLE ${duck.qid(name)} (${defs})`);
      tables.add(name);
      if (!rows.length) return;
      const values = rows
        .map((row) => `(${row.map((value, k) => typedLiteral(duck.qlit, value, columns[k].type)).join(", ")})`)
        .join(", ");
      await duck.exec(`INSERT INTO ${duck.qid(name)} VALUES ${values}`);
    },

    /** Write a table to a Parquet file's bytes, for source-file cases. */
    async tableToParquet(name) {
      const virtual = `__fx_${name}.parquet`;
      await duck.exec(`COPY ${duck.qid(name)} TO ${duck.qlit(virtual)} (FORMAT PARQUET)`);
      const bytes = await duck.db().copyFileToBuffer(virtual);
      await duck.db().dropFile(virtual);
      return Array.from(bytes);
    },

    async loadSourceFile(fileName, bytes) {
      const file = new File([new Uint8Array(bytes)], fileName);
      const made = await sources.addLocalFile(file);
      return made.map((source) => ({ id: source.id, name: source.name, format: source.format, rows: source.rows }));
    },

    /** nodes: [{ key, type, params }], edges: [{ from, fromPort, to, toPort }] by key. */
    buildGraph(nodes, edges) {
      graph.clear();
      const ids = {};
      for (const spec of nodes) {
        const node = graph.addNode(spec.type, 0, 0);
        Object.assign(node.params, structuredClone(spec.params || {}));
        ids[spec.key] = node.id;
      }
      for (const edge of edges) graph.addEdge(ids[edge.from], edge.fromPort, ids[edge.to], edge.toPort);
      return ids;
    },

    async compile() {
      const result = await graph.compile(sources.sources);
      return {
        views: Object.fromEntries(result.views),
        crs: Object.fromEntries(result.crsByNode),
        error: result.error,
      };
    },

    async readPort(view) {
      const described = await duck.query(`DESCRIBE ${view}`);
      const columns = described.map((row) => ({ name: row.column_name, type: String(row.column_type).toUpperCase() }));
      if (!columns.length) return { columns, rows: [] };
      const selection = columns.map((c) => readableColumn(duck.qid, c)).join(", ");
      const data = await duck.query(`SELECT ${selection} FROM ${view}`);
      return { columns, rows: data.map((row) => columns.map((c) => row[c.name] ?? null)) };
    },

    async query(sql) {
      return duck.query(sql);
    },

    async runWriter(view, format, fileName, crs) {
      downloads.length = 0;
      const result = await writer.runWriter(view, format, fileName, { crs });
      const files = [];
      for (const download of downloads) {
        files.push({ name: download.name, bytes: Array.from(new Uint8Array(await download.blob.arrayBuffer())) });
      }
      return { note: result?.note ?? null, files };
    },

    async teardown() {
      graph.clear();
      await graph.compile(sources.sources).catch(() => {});
      for (const name of tables) await duck.exec(`DROP TABLE IF EXISTS ${duck.qid(name)}`);
      tables.clear();
    },
  };
  return api;
}
