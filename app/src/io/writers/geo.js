/* GeoParquet (with its metadata self-check) and GeoJSON (assembled in SQL). */

import { db, exec, qid, qlit, query } from "../../core/duck.js";
import { LONLAT, describe, findGeometryColumn, geometryExpression, isLonLatCode } from "../../core/schema.js";
import { download, exportParquet, virtualName } from "./index.js";

/**
 * The `geo` block a reader needs to treat a WKB column as geometry.
 *
 * `crs: null` is the spec's way of saying OGC:CRS84, so it is only honest for
 * a stream that really is lon/lat. A Reprojector upstream makes it a lie,
 * and the code goes in as a plain string instead — not the PROJJSON the spec
 * asks for, but unambiguous to a human reading the sidecar, which is the point
 * of writing one at all.
 */
function geoSidecar(geometryColumnName, crs) {
  return {
    version: "1.1.0",
    primary_column: geometryColumnName,
    columns: {
      [geometryColumnName]: {
        encoding: "WKB",
        geometry_types: [],
        crs: isLonLatCode(crs) ? null : crs,
      },
    },
  };
}

async function hasGeoMetadata(virtualFile) {
  try {
    const rows = await query(
      `SELECT count(*) AS n FROM parquet_kv_metadata(${qlit(virtualFile)}) WHERE decode(key) = 'geo'`,
    );
    return Number(rows[0]?.n ?? 0) > 0;
  } catch (err) {
    console.warn("Could not inspect the written parquet's metadata", err);
    return false;
  }
}

export async function exportGeoParquet(viewName, baseName, crs = LONLAT) {
  const columns = await describe(viewName);
  const geometry = findGeometryColumn(columns);
  if (!geometry) {
    // Nothing spatial to preserve, so this is just a parquet.
    const result = await exportParquet(viewName, baseName);
    return { ...result, note: "No geometry column — written as plain Parquet." };
  }

  // Present the geometry as DuckDB's GEOMETRY type, which is the only form the
  // spatial writer would attach metadata to.
  const others = columns.filter((column) => column.name !== geometry.name).map((column) => qid(column.name));
  const selection = [...others, `${geometryExpression(geometry)} AS ${qid(geometry.name)}`].join(", ");
  const virtual = virtualName("parquet");

  // Not copyToBuffer(): the footer has to be inspected while the file is still
  // in the WASM filesystem, and that helper drops it on the way out.
  await exec(`COPY (SELECT ${selection} FROM ${viewName}) TO ${qlit(virtual)} (FORMAT PARQUET)`);
  let compliant = false;
  let bytes;
  try {
    compliant = await hasGeoMetadata(virtual);
    bytes = await db().copyFileToBuffer(virtual);
  } finally {
    try {
      await db().dropFile(virtual);
    } catch (err) {
      console.warn(`Could not drop ${virtual} from the WASM filesystem`, err);
    }
  }

  download(bytes, `${baseName}.parquet`, "application/octet-stream");
  // DuckDB writes no CRS into the block it does write, so a projected stream
  // would be read back as lon/lat. The sidecar is the only place left to say
  // what these coordinates are, which makes it worth writing even when the
  // block itself came out fine.
  const projected = !isLonLatCode(crs);
  if (compliant && !projected) {
    return { file: `${baseName}.parquet`, note: null };
  }

  const sidecar = JSON.stringify(geoSidecar(geometry.name, crs), null, 2);
  download(new TextEncoder().encode(sidecar), `${baseName}.geo.json`, "application/json");
  const reason = compliant
    ? `The geometry is in ${crs}, and DuckDB writes no CRS into GeoParquet — a reader will take it ` +
      "for lon/lat unless the .geo.json sidecar is applied."
    : "This build of DuckDB did not write the GeoParquet metadata block, so the geometry is " +
      "plain WKB and a .geo.json sidecar describes it. Most readers will need the sidecar applied.";
  return { file: `${baseName}.parquet`, note: reason };
}

/**
 * The `crs` member naming a projected GeoJSON's coordinate system.
 *
 * An authority code becomes the URN form GDAL emits and expects; anything else
 * — a raw `+proj=` string — goes in verbatim, which no reader will resolve
 * automatically but a human opening the file certainly will. Better than a
 * file that says nothing about coordinates that are plainly not degrees.
 */
function crsMember(crs) {
  const authority = /^([A-Za-z][\w.-]*):(\d+)$/.exec(crs);
  const name = authority ? `urn:ogc:def:crs:${authority[1].toUpperCase()}::${authority[2]}` : crs;
  return { type: "name", properties: { name } };
}

/*
 * GeoJSON, assembled in SQL rather than written by GDAL.
 *
 * duckdb-wasm ships GDAL and `st_drivers()` reports GeoJSON as writable, but
 * `COPY … (FORMAT GDAL, DRIVER 'GeoJSON')` dies on "Cannot write feature" in
 * the WASM filesystem — as does every other GDAL driver tried. ST_AsGeoJSON
 * and json_object are plain SQL and always there, so the document is built
 * from those instead: one row per feature, joined here.
 *
 * The coordinates go out in whatever the stream is already in. RFC 7946 says a
 * GeoJSON file is WGS84 and deleted the `crs` member to make the point, but
 * reprojecting on the way out would silently undo a Reprojector the user
 * put there deliberately — so a projected file keeps its coordinates and names
 * its CRS in the 2008 spec's `crs` member instead, which is what GDAL and QGIS
 * both write and read. Lon/lat, the common case, omits the member and is
 * RFC 7946 to the letter.
 *
 * A NULL geometry becomes `"geometry": null`, which every version of the spec
 * allows, rather than dropping the row and its attributes.
 */
export async function exportGeoJson(viewName, baseName, crs = LONLAT) {
  const columns = await describe(viewName);
  const geometry = findGeometryColumn(columns);
  if (!geometry) {
    throw new Error("GeoJSON has to carry geometry and this output has none — write Parquet or CSV instead.");
  }
  // json_object takes alternating key literal and value, so the attribute
  // names survive spaces and accents that a struct_pack key would not.
  const pairs = columns
    .filter((column) => column.name !== geometry.name)
    .flatMap((column) => [qlit(column.name), qid(column.name)]);
  const properties = pairs.length ? `json_object(${pairs.join(", ")})` : "'{}'::JSON";

  const rows = await query(
    `SELECT json_object('type', 'Feature',` +
      ` 'geometry', ST_AsGeoJSON(${geometryExpression(geometry)})::JSON,` +
      ` 'properties', ${properties})::VARCHAR AS feature FROM ${viewName}`,
  );

  // The member sits between "type" and "features", where every reader that
  // still honours it expects to find it.
  const projected = !isLonLatCode(crs);
  const header = projected ? `"crs":${JSON.stringify(crsMember(crs))},` : "";
  const document = `{"type":"FeatureCollection",${header}"features":[${rows.map((row) => row.feature).join(",")}]}`;
  download(new TextEncoder().encode(document), `${baseName}.geojson`, "application/geo+json");
  return {
    file: `${baseName}.geojson`,
    note: projected
      ? `Written in ${crs}, named in the file's "crs" member. GDAL and QGIS honour that; a reader ` +
        "that follows RFC 7946 strictly will take the coordinates for lon/lat."
      : null,
  };
}
