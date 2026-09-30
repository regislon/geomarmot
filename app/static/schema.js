/*
 * Column introspection and geometry detection.
 *
 * The awkward part is telling apart the two ways geometry reaches us. A
 * GeoParquet written by GeoPandas is claimed by duckdb-wasm's bundled spatial
 * extension as its own GEOMETRY type, and has to be converted back with
 * ST_AsWKB() before the decoder can read it. A file written by plain pandas
 * carries the same bytes in an ordinary BLOB, and wrapping *that* in ST_AsWKB()
 * produces DuckDB's internal serialisation instead of WKB — the decoder then
 * sees a `02 04 …` header where it expects `01 03 00 00 00` and throws on every
 * single feature.
 *
 * So the decision is made from the declared column type, never from the column
 * name.
 *
 * All of this assumes the spatial extension is loaded, which `duck.js` does at
 * boot — do not rely on DuckDB's auto-load, which only fires once a GeoParquet
 * has actually been read.
 */

import { query, qid, qlit } from "./duck.js";

const GEOMETRY_COLUMN_NAMES = new Set(["geometry", "geom", "the_geom", "wkb_geometry", "geometry_wkb", "wkb"]);

/** Return [{name, type}] for a view or table. */
export async function describe(relation) {
  const rows = await query(`DESCRIBE ${relation}`);
  return rows.map((row) => ({ name: row.column_name, type: String(row.column_type || "").toUpperCase() }));
}

/**
 * Pick the geometry column, if there is one.
 *
 * Returns {name, kind} where kind is "geometry" (needs ST_AsWKB) or "wkb" (use
 * the bytes as they are), or null when the relation carries no geometry.
 */
export function findGeometryColumn(columns) {
  const native = columns.find((column) => column.type === "GEOMETRY");
  if (native) return { name: native.name, kind: "geometry" };

  const blob = columns.find(
    (column) => column.type === "BLOB" && GEOMETRY_COLUMN_NAMES.has(column.name.toLowerCase()),
  );
  if (blob) return { name: blob.name, kind: "wkb" };

  return null;
}

/** SQL that yields plain WKB bytes for a geometry column. */
export function wkbExpression(geometryColumn) {
  const column = qid(geometryColumn.name);
  return geometryColumn.kind === "geometry" ? `ST_AsWKB(${column})` : column;
}

/** SQL that yields a geometry value, whichever representation it started in. */
export function geometryExpression(geometryColumn) {
  const column = qid(geometryColumn.name);
  return geometryColumn.kind === "geometry" ? column : `ST_GeomFromWKB(${column})`;
}

/**
 * Read the GeoParquet `geo` metadata block from a registered file.
 *
 * Returns the parsed object, or null when the file has none (a plain parquet,
 * or a GeoParquet whose writer skipped the block). Reads only the footer.
 */
export async function readGeoMetadata(fileName) {
  try {
    const rows = await query(
      `SELECT decode(value) AS value FROM parquet_kv_metadata(${qlit(fileName)}) WHERE decode(key) = 'geo'`,
    );
    if (!rows.length) return null;
    return JSON.parse(rows[0].value);
  } catch (err) {
    console.warn(`Could not read GeoParquet metadata from ${fileName}`, err);
    return null;
  }
}

/**
 * CRS of a GeoParquet, as {code, assumed}.
 *
 * GeoParquet stores CRS as PROJJSON. The spec's default when the block is
 * absent is OGC:CRS84 — lon/lat — and most files in the wild really are that.
 * But a plain WKB blob carries no CRS signal whatsoever, and quietly calling
 * that 4326 is how a dataset in a metre-based projection ends up drawn in the
 * Gulf of Guinea. So the guess is flagged: `assumed` is true whenever the file
 * did not actually say, and the UI shows it as such.
 */
export function crsFromGeoMetadata(geoMetadata) {
  const primary = geoMetadata?.columns?.[geoMetadata.primary_column];
  const crs = primary?.crs;
  // An explicit null is the spec's way of saying "this really is lon/lat".
  if (crs === null) return { code: "EPSG:4326", assumed: false };
  if (!crs) return { code: "EPSG:4326", assumed: true };
  if (typeof crs === "string") return { code: crs, assumed: false };
  const code = crs.id?.code;
  const authority = crs.id?.authority;
  if (code && authority) return { code: `${authority}:${code}`, assumed: false };
  return { code: crs.name || "unknown", assumed: !crs.name };
}

/** What the graph normalises to, and what the map and the H3 nodes expect. */
export const LONLAT = "EPSG:4326";

/** True when geometry in this CRS can go straight to the map. */
export function isLonLat(crs) {
  return ["EPSG:4326", "OGC:CRS84", "CRS84", "WGS 84", "WGS84"].includes(crs?.code);
}

/** The same test for a bare code, which is how the graph carries a CRS. */
export function isLonLatCode(code) {
  return isLonLat({ code });
}

/** Row count of a relation. */
export async function countRows(relation) {
  const rows = await query(`SELECT count(*) AS n FROM ${relation}`);
  return Number(rows[0]?.n ?? 0);
}

const NUMERIC_TYPE = /^(DOUBLE|FLOAT|REAL|DECIMAL|U?BIGINT|U?INTEGER|U?SMALLINT|U?TINYINT|HUGEINT)/;

/**
 * Values worth offering for a column, for the Tester and TestFilter inputs.
 *
 * What is useful differs by type. For a text column it is the values that are
 * actually in there — you are almost always matching one of them, and typing a
 * category from memory is how you get a rule that silently matches nothing. For
 * a numeric column the distinct values are usually meaningless (they are
 * measurements), so the useful offers are the landmarks you would pick a
 * threshold from.
 */
export async function valueSuggestions(relation, column, type) {
  if (!relation || !column) return [];
  const reference = qid(column);
  if (NUMERIC_TYPE.test(type || "")) {
    const rows = await query(
      `SELECT min(v) AS lo, quantile_cont(v, 0.25) AS q1, median(v) AS mid,
              quantile_cont(v, 0.75) AS q3, max(v) AS hi
       FROM (SELECT ${reference} AS v FROM ${relation} WHERE ${reference} IS NOT NULL)`,
    );
    const stats = rows[0] || {};
    return [stats.lo, stats.q1, stats.mid, stats.q3, stats.hi]
      .filter((value) => value !== null && value !== undefined)
      .map((value) => String(Number(value.toFixed ? Number(value.toFixed(4)) : value)));
  }
  const rows = await distinctValues(relation, column, 50);
  return rows.map((row) => String(row.value));
}

/** Distinct values of a column, capped — used to build AttributeFilter ports. */
export async function distinctValues(relation, column, limit = 50) {
  const rows = await query(
    `SELECT ${qid(column)} AS value, count(*) AS n FROM ${relation}
     WHERE ${qid(column)} IS NOT NULL
     GROUP BY 1 ORDER BY n DESC, 1 LIMIT ${limit}`,
  );
  return rows.map((row) => ({ value: row.value, count: Number(row.n) }));
}
