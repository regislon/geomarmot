// @ts-check
/*
 * The GeoPackage format (OGC GeoPackage 1.3), written into an SQLite database.
 *
 * GDAL inside DuckDB-Wasm cannot write a GeoPackage (its SQLite cannot write
 * to the Wasm file system), so GeoMarmot writes one itself: an SQLite database
 * (sql.js) holding the tables the standard requires — gpkg_spatial_ref_sys,
 * gpkg_contents, gpkg_geometry_columns — and one feature table whose geometry
 * column holds GeoPackage binary: a small header (magic, flags, SRS id, the
 * envelope) followed by ISO WKB.
 *
 * This module knows nothing of DuckDB: it takes a sql.js Database and rows.
 */

/** "GPKG" as the SQLite application id, and GeoPackage 1.3. */
export const APPLICATION_ID = 0x47504b47;
export const USER_VERSION = 10300;

const WGS84_WKT =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],' +
  'AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,' +
  'AUTHORITY["EPSG","9122"]],AXIS["Latitude",NORTH],AXIS["Longitude",EAST],AUTHORITY["EPSG","4326"]]';

/** The geometry type names a geometry column may declare. */
export const GEOMETRY_TYPES = new Set([
  "GEOMETRY",
  "POINT",
  "LINESTRING",
  "POLYGON",
  "MULTIPOINT",
  "MULTILINESTRING",
  "MULTIPOLYGON",
  "GEOMETRYCOLLECTION",
]);

/** A quoted SQLite identifier. */
export const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** The tables every GeoPackage has, and the three spatial reference systems it must define. */
export function createCore(db) {
  db.run(`PRAGMA application_id = ${APPLICATION_ID}`);
  db.run(`PRAGMA user_version = ${USER_VERSION}`);
  db.run(`CREATE TABLE gpkg_spatial_ref_sys (
    srs_name TEXT NOT NULL, srs_id INTEGER PRIMARY KEY, organization TEXT NOT NULL,
    organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT)`);
  db.run(`CREATE TABLE gpkg_contents (
    table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE,
    description TEXT DEFAULT '', last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER,
    CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id))`);
  db.run(`CREATE TABLE gpkg_geometry_columns (
    table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL,
    srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL,
    CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
    CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
    CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id))`);
  // GDAL's own table of feature counts: not in the standard, but GDAL (QGIS, DuckDB's st_read) reads
  // a layer through its fast path only when it is there.
  db.run("CREATE TABLE gpkg_ogr_contents (table_name TEXT NOT NULL PRIMARY KEY, feature_count INTEGER DEFAULT NULL)");
  const srs = db.prepare("INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?)");
  srs.run([
    "WGS 84 geodetic",
    4326,
    "EPSG",
    4326,
    WGS84_WKT,
    "longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid",
  ]);
  srs.run(["Undefined cartesian SRS", -1, "NONE", -1, "undefined", "undefined cartesian coordinate reference system"]);
  srs.run(["Undefined geographic SRS", 0, "NONE", 0, "undefined", "undefined geographic coordinate reference system"]);
  srs.free();
}

/**
 * The SRS id for a CRS code, adding it to gpkg_spatial_ref_sys when it is not
 * one of the three every GeoPackage has. `definition` is its WKT when known;
 * otherwise the organisation and code identify it (GDAL resolves EPSG codes).
 * @param {any} db
 * @param {string|null} crs     "EPSG:2056", or null for none
 * @param {string} [definition]
 */
export function srsFor(db, crs, definition = "undefined") {
  if (!crs) return -1;
  const [organization, code] = String(crs).split(":");
  const id = Number(code);
  if (organization?.toUpperCase() === "EPSG" && id === 4326) return 4326;
  if (!Number.isInteger(id)) return -1;
  // srs_id is our own key: the EPSG code itself, as GDAL and QGIS do.
  db.run("INSERT OR IGNORE INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?)", [
    crs,
    id,
    organization.toUpperCase(),
    id,
    definition,
    "",
  ]);
  return id;
}

/**
 * GeoPackage binary for one geometry: the header, then the ISO WKB as given.
 * @param {Uint8Array} wkb
 * @param {number} srsId
 * @param {{ minx: number, maxx: number, miny: number, maxy: number } | null} envelope  null for an empty geometry
 */
export function geometryBlob(wkb, srsId, envelope) {
  const empty = envelope === null;
  const header = new ArrayBuffer(empty ? 8 : 40);
  const view = new DataView(header);
  view.setUint8(0, 0x47); // "G"
  view.setUint8(1, 0x50); // "P"
  view.setUint8(2, 0); // version 1
  // Flags: little-endian (bit 0), envelope [minx, maxx, miny, maxy] (code 1, bits 1–3), or empty (bit 4).
  view.setUint8(3, empty ? 0b00010001 : 0b00000011);
  view.setInt32(4, srsId, true);
  if (!empty) {
    view.setFloat64(8, envelope.minx, true);
    view.setFloat64(16, envelope.maxx, true);
    view.setFloat64(24, envelope.miny, true);
    view.setFloat64(32, envelope.maxy, true);
  }
  const blob = new Uint8Array(header.byteLength + wkb.byteLength);
  blob.set(new Uint8Array(header), 0);
  blob.set(wkb, header.byteLength);
  return blob;
}

/**
 * Create the feature (or attributes) table and register it.
 * @param {any} db
 * @param {{ table: string, fid: string, geometry: string|null, columns: Array<{ name: string, type: string }> }} layer
 */
export function createLayer(db, { table, fid, geometry, columns }) {
  const defs = [`${ident(fid)} INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL`];
  if (geometry) defs.push(`${ident(geometry)} GEOMETRY`);
  for (const column of columns) defs.push(`${ident(column.name)} ${column.type}`);
  db.run(`CREATE TABLE ${ident(table)} (${defs.join(", ")})`);
}

/**
 * Finish a layer: its row in gpkg_contents (with the extent) and, for features,
 * in gpkg_geometry_columns (with the type its geometries share, or GEOMETRY).
 * @param {any} db
 * @param {{ table: string, geometry: string|null, srsId: number, extent: number[]|null, types: Set<string>, hasZ: boolean, count?: number|null }} layer
 */
export function registerLayer(db, { table, geometry, srsId, extent, types, hasZ, count = null }) {
  const [minx, miny, maxx, maxy] = extent || [null, null, null, null];
  db.run("INSERT INTO gpkg_ogr_contents VALUES (?, ?)", [table, count]);
  db.run(
    "INSERT INTO gpkg_contents (table_name, data_type, identifier, min_x, min_y, max_x, max_y, srs_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [table, geometry ? "features" : "attributes", table, minx, miny, maxx, maxy, geometry ? srsId : null],
  );
  if (!geometry) return;
  const only = types.size === 1 ? [...types][0] : "GEOMETRY";
  const typeName = GEOMETRY_TYPES.has(only) ? only : "GEOMETRY";
  db.run("INSERT INTO gpkg_geometry_columns VALUES (?, ?, ?, ?, ?, ?)", [
    table,
    geometry,
    typeName,
    srsId,
    hasZ ? 1 : 0,
    0,
  ]);
}

/** The GeoPackage column type for a DuckDB type. */
export function columnType(duckType) {
  const type = String(duckType).toUpperCase();
  if (type === "BOOLEAN") return "BOOLEAN";
  if (/^(U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|HUGEINT|UHUGEINT)$/.test(type)) return "INTEGER";
  if (/^(FLOAT|DOUBLE|REAL|DECIMAL.*)$/.test(type)) return "REAL";
  if (type === "DATE") return "DATE";
  if (/^TIMESTAMP/.test(type)) return "DATETIME";
  if (type === "BLOB") return "BLOB";
  return "TEXT";
}
