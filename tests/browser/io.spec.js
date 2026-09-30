/*
 * Readers and writers, through the real source registry and the real writers.
 */

import { test, expect } from "@playwright/test";
import * as XLSX from "xlsx";
import { openHarness } from "../harness/target.js";
import { gzipSync } from "node:zlib";
import { flatgeobuf, geopackage, hasOgr2ogr, points, workbook } from "../fixtures/build.js";

let h;
test.beforeAll(async ({ browser }) => {
  h = await openHarness(browser);
});
test.afterAll(async () => h?.server.close());

/** Load a file, then read the Reader's output for its first (or named) source. */
async function readSource(fileName, bytes, { layer, params = {} } = {}) {
  return h.page.evaluate(
    async ({ fileName, bytes, layer, params }) => {
      const api = window.__geomarmotHarness;
      const made = await api.loadSourceFile(fileName, bytes);
      const source = layer ? made.find((s) => s.name.endsWith(`› ${layer}`)) : made[0];
      const ids = api.buildGraph([{ key: "r", type: "Reader", params: { sourceId: source.id, ...params } }], []);
      const compiled = await api.compile();
      if (compiled.error) throw new Error(compiled.error.message);
      return { made, table: await api.readPort(compiled.views[ids.r].output), crs: compiled.crs[ids.r] };
    },
    { fileName, bytes: Array.from(bytes), layer, params },
  );
}

async function tableBytes(columns, rows, name) {
  return h.page.evaluate(
    async ({ columns, rows, name }) => {
      const api = window.__geomarmotHarness;
      await api.createTable(name, columns, rows);
      return api.tableToParquet(name);
    },
    { columns, rows, name },
  );
}

test.describe("readers", () => {
  test("Parquet, with and without the physical row number", async () => {
    const bytes = await tableBytes([{ name: "s", type: "VARCHAR" }], [["a"], ["b"]], "io_pq");
    const plain = await readSource("plain.parquet", bytes);
    expect(plain.table.columns.map((c) => c.name)).toEqual(["s"]);
    const numbered = await readSource("numbered.parquet", bytes, { params: { rowNumber: "Yes" } });
    expect(numbered.table.columns.map((c) => c.name)).toEqual(["s", "file_row_number"]);
    expect(numbered.table.rows).toEqual([
      ["a", "0"],
      ["b", "1"],
    ]);
  });

  test("GeoParquet geometry arrives as lon/lat", async () => {
    const bytes = await tableBytes(
      [
        { name: "id", type: "INTEGER" },
        { name: "geometry", type: "GEOMETRY" },
      ],
      [[1, "POINT (7 46)"]],
      "io_geo",
    );
    const read = await readSource("pts.parquet", bytes);
    expect(read.table.rows).toEqual([[1, "POINT (7 46)"]]);
    expect(read.crs).toBe("EPSG:4326");
  });

  test("CSV: the sniffer finds the delimiter and the types", async () => {
    const csv = Buffer.from("id;name;v\n1;a;1.5\n2;b;2\n");
    const read = await readSource("semi.csv", csv);
    expect(read.table.columns).toEqual([
      { name: "id", type: "BIGINT" },
      { name: "name", type: "VARCHAR" },
      { name: "v", type: "DOUBLE" },
    ]);
    expect(read.table.rows).toEqual([
      ["1", "a", 1.5],
      ["2", "b", 2],
    ]);
  });

  test("TSV and gzipped CSV", async () => {
    const tsv = await readSource("tabs.tsv", Buffer.from("id\tname\n1\ta\n"));
    expect(tsv.table.rows).toEqual([["1", "a"]]);
    const gz = await readSource("packed.csv.gz", gzipSync(Buffer.from("id,name\n1,a\n2,b\n")));
    expect(gz.table.rows.length).toBe(2);
  });

  test("GeoJSON, as .geojson and as .json", async () => {
    const collection = JSON.stringify(points([[7, 46, { name: "a" }]]));
    for (const name of ["pts.geojson", "pts.json"]) {
      const read = await readSource(name, Buffer.from(collection));
      const geometry = read.table.columns.findIndex((c) => c.type === "GEOMETRY");
      expect(read.table.rows[0][geometry], name).toBe("POINT (7 46)");
    }
  });

  test("FlatGeobuf", async () => {
    test.skip(!hasOgr2ogr(), "ogr2ogr (GDAL) is needed to build the FlatGeobuf fixture");
    const read = await readSource("sites.fgb", flatgeobuf("sites.fgb", points([[8, 47, { n: "x" }]])));
    const geometry = read.table.columns.findIndex((c) => c.type === "GEOMETRY");
    expect(read.table.rows[0][geometry]).toBe("POINT (8 47)");
  });

  test("GeoPackage: one source per layer", async () => {
    test.skip(!hasOgr2ogr(), "ogr2ogr (GDAL) is needed to build the GeoPackage fixture");
    const bytes = geopackage("multi.gpkg", {
      plots: points([
        [1, 2, { name: "p1" }],
        [3, 4, { name: "p2" }],
      ]),
      mills: points([[5, 6, { name: "m1" }]]),
    });
    const read = await readSource("multi.gpkg", bytes, { layer: "mills" });
    expect(read.made.map((s) => s.name).sort()).toEqual(["multi.gpkg › mills", "multi.gpkg › plots"]);
    expect(read.table.rows.length).toBe(1);
    const geometry = read.table.columns.findIndex((c) => c.type === "GEOMETRY");
    expect(read.table.rows[0][geometry]).toBe("POINT (5 6)");
  });

  test("GeoPackage in a projected CRS is reprojected to lon/lat on read", async () => {
    test.skip(!hasOgr2ogr(), "ogr2ogr (GDAL) is needed to build the GeoPackage fixture");
    const bytes = geopackage(
      "lv95.gpkg",
      { sites: points([[2600000, 1200000, { name: "Bern" }]]) },
      { srs: "EPSG:2056" },
    );
    const read = await readSource("lv95.gpkg", bytes);
    const geometry = read.table.columns.findIndex((c) => c.type === "GEOMETRY");
    const [x, y] = read.table.rows[0][geometry].match(/-?[\d.]+/g).map(Number);
    expect(x).toBeCloseTo(7.4386, 3);
    expect(y).toBeCloseTo(46.951, 3);
  });

  test("Excel: per-cell types, dates without a time-zone shift, IDs kept as text", async () => {
    const bytes = workbook({
      sheet: [
        ["id", "n", "x", "when", "ok", "mixed", ""],
        // Date cells as Excel stores them: a serial number with a date format.
        ["007", 1, 1.5, { t: "n", v: 45293, z: "yyyy-mm-dd" }, true, 1, null],
        ["010", 2, 2, { t: "n", v: 45657, z: "yyyy-mm-dd" }, false, "n/a", null],
      ],
    });
    const read = await readSource("book.xlsx", bytes);
    expect(read.table.columns).toEqual([
      { name: "id", type: "VARCHAR" },
      { name: "n", type: "BIGINT" },
      { name: "x", type: "DOUBLE" },
      { name: "when", type: "DATE" },
      { name: "ok", type: "BOOLEAN" },
      { name: "mixed", type: "VARCHAR" },
    ]);
    expect(read.table.rows).toEqual([
      ["007", "1", 1.5, "2024-01-02", true, "1"],
      ["010", "2", 2, "2024-12-31", false, "n/a"],
    ]);
  });
});

async function write(format, columns, rows, crs = "EPSG:4326") {
  return h.page.evaluate(
    async ({ format, columns, rows, crs }) => {
      const api = window.__geomarmotHarness;
      await api.createTable("io_out", columns, rows);
      return api.runWriter("io_out", format, "out", crs);
    },
    { format, columns, rows, crs },
  );
}

const pointColumns = [
  { name: "id", type: "INTEGER" },
  { name: "name", type: "VARCHAR" },
  { name: "geometry", type: "GEOMETRY" },
];

test.describe("writers", () => {
  test("Parquet and CSV", async () => {
    const pq = await write("Parquet", pointColumns, [[1, "a", "POINT (1 2)"]]);
    expect(pq.files[0].name).toBe("out.parquet");
    const csv = await write(
      "CSV",
      [
        { name: "id", type: "INTEGER" },
        { name: "name", type: "VARCHAR" },
      ],
      [[1, "a, b"]],
    );
    expect(Buffer.from(csv.files[0].bytes).toString()).toBe('id,name\n1,"a, b"\n');
  });

  test("GeoParquet carries valid geo metadata", async () => {
    const out = await write("GeoParquet", pointColumns, [[1, "a", "POINT (1 2)"]]);
    expect(out.files.map((f) => f.name)).toContain("out.parquet");
    const meta = await h.page.evaluate(
      async (bytes) => {
        const api = window.__geomarmotHarness;
        const made = await api.loadSourceFile("roundtrip.parquet", bytes);
        const rows = await api.query(
          `SELECT decode(value) AS v FROM parquet_kv_metadata('${made[0].id}') WHERE decode(key) = 'geo'`,
        );
        return rows[0]?.v;
      },
      out.files.find((f) => f.name === "out.parquet").bytes,
    );
    const geo = JSON.parse(meta);
    expect(geo.primary_column).toBe("geometry");
    expect(geo.columns.geometry.encoding).toBe("WKB");
  });

  test("GeoJSON: lon/lat has no CRS member; a projected stream names its CRS", async () => {
    const plain = JSON.parse(
      Buffer.from((await write("GeoJSON", pointColumns, [[1, "a", "POINT (1 2)"]])).files[0].bytes).toString(),
    );
    expect(plain.crs).toBeUndefined();
    expect(plain.features[0]).toEqual({
      type: "Feature",
      geometry: { type: "Point", coordinates: [1, 2] },
      properties: { id: 1, name: "a" },
    });
    const projected = JSON.parse(
      Buffer.from(
        (await write("GeoJSON", pointColumns, [[1, "a", "POINT (2600000 1200000)"]], "EPSG:2056")).files[0].bytes,
      ).toString(),
    );
    expect(JSON.stringify(projected.crs)).toContain("2056");
  });

  test("Excel: geometry as WKT, 64-bit integers as text, dates as real dates, long WKT left blank", async () => {
    const longLine = `LINESTRING (${Array.from({ length: 4000 }, (_, k) => `${k} ${k}`).join(", ")})`;
    const out = await write(
      "Excel",
      [
        { name: "id", type: "BIGINT" },
        { name: "day", type: "DATE" },
        { name: "geometry", type: "GEOMETRY" },
      ],
      [
        ["9007199254740993", "2024-01-02", "POINT (1 2)"],
        ["1", "2024-12-31", longLine],
      ],
    );
    expect(out.note || "").toMatch(/32,767|blank/i);
    const book = XLSX.read(Buffer.from(out.files[0].bytes), { type: "buffer" });
    const sheet = book.Sheets[book.SheetNames[0]];
    expect(sheet.A2.t).toBe("s");
    expect(sheet.A2.v).toBe("9007199254740993");
    expect(sheet.B2.t).toBe("n");
    expect(XLSX.SSF.format("yyyy-mm-dd", sheet.B2.v)).toBe("2024-01-02");
    expect(sheet.C2.v).toBe("POINT (1 2)");
    expect(sheet.C3?.v ?? "").toBe("");
  });
});
