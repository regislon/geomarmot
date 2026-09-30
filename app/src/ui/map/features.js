/*
 * Building the features the map draws: geometry from any view, H3 cells as
 * hexagons (optionally rolled up to a coarser resolution), with a display cap.
 */

import { guardedRead } from "../read-guard.js";
import { LONLAT, geometryExpression, isLonLatCode, wkbExpression } from "../../core/schema.js";
import { hasSpatial, qid, qlit, query } from "../../core/duck.js";
import { decodeWKB } from "../../core/wkb.js";
import { H3_INDEX_COLUMN, cellToPolygon, parentIndexExpr, resolutionExpr } from "../../engines/h3/index.js";
import { SLOW_FEATURE_COUNT, boundsOf, coarsenResolution, featureLimit } from "./index.js";

function limitClause() {
  return featureLimit ? ` LIMIT ${featureLimit}` : "";
}

/** The trailing note on the status line: was anything left out, or is this slow? */
function volumeNote(drawn) {
  if (featureLimit && drawn === featureLimit) {
    return ` (capped at ${featureLimit.toLocaleString()} — raise the limit to draw more)`;
  }
  if (drawn >= SLOW_FEATURE_COUNT) return " — this many will make the map sluggish";
  return "";
}

/**
 * Whether a bounding box could plausibly be longitude/latitude.
 *
 * This is the runtime stand-in for CRS provenance. Tracking a CRS through
 * arbitrary transformers is a bigger job than v1 needs, but geometry in a
 * metre-based projection has coordinates in the hundreds of thousands, so it
 * announces itself the moment it is measured — and drawing it anyway would put
 * a Swiss field in the Gulf of Guinea.
 */
function looksLikeLonLat(bounds) {
  const [minX, minY, maxX, maxY] = bounds;
  return minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90;
}

/** Columns worth averaging when cells are rolled up. */
const NUMERIC_TYPE = /^(DOUBLE|FLOAT|REAL|DECIMAL|U?BIGINT|U?INTEGER|U?SMALLINT|U?TINYINT|HUGEINT)/;

/** Every cell drawn as itself. */
async function fetchH3Detail(viewName, columns) {
  const attributes = columns.filter((column) => column.name !== H3_INDEX_COLUMN).map((column) => qid(column.name));
  const selection = [qid(H3_INDEX_COLUMN), ...attributes].join(", ");
  return query(`SELECT ${selection} FROM ${viewName} WHERE ${qid(H3_INDEX_COLUMN)} IS NOT NULL${limitClause()}`);
}

/**
 * Cells rolled up to a coarser resolution.
 *
 * The grouping happens in DuckDB, so the whole tile is summarised without a
 * single extra row crossing into JavaScript — which is the only way to see all
 * of an 823,543-cell tile at once. Numeric attributes are averaged and the
 * child count is carried, so a hexagon still says something; anything
 * non-numeric is dropped rather than picked arbitrarily.
 */
async function fetchH3Coarse(viewName, columns, parentRes) {
  const parent = parentIndexExpr(H3_INDEX_COLUMN, parentRes);
  const averages = columns
    .filter((column) => column.name !== H3_INDEX_COLUMN && NUMERIC_TYPE.test(column.type))
    .map((column) => `avg(${qid(column.name)}) AS ${qid(column.name)}`);
  const selection = [`${parent} AS ${qid(H3_INDEX_COLUMN)}`, "count(*) AS cells", ...averages].join(", ");
  return query(
    `SELECT ${selection} FROM ${viewName} WHERE ${qid(H3_INDEX_COLUMN)} IS NOT NULL
     GROUP BY 1${limitClause()}`,
  );
}

/**
 * Features for a view whose geometry lives in an H3 index.
 *
 * Boundaries are computed here, for what is actually drawn — never up front for
 * the whole tile, which for a res-6 dense tile would be 823,543 hexagons.
 */
export async function h3Features(viewName, columns) {
  const detected = await guardedRead(() =>
    query(
      `SELECT ${resolutionExpr(H3_INDEX_COLUMN)} AS res FROM ${viewName}
     WHERE ${qid(H3_INDEX_COLUMN)} IS NOT NULL LIMIT 1`,
    ),
  );
  const dataResolution = detected.length ? Number(detected[0].res) : null;

  const coarse = coarsenResolution !== null && dataResolution !== null && coarsenResolution < dataResolution;
  const rows = coarse
    ? await fetchH3Coarse(viewName, columns, coarsenResolution)
    : await fetchH3Detail(viewName, columns);

  const features = [];
  let failed = 0;
  for (const row of rows) {
    try {
      features.push({ type: "Feature", geometry: cellToPolygon(row[H3_INDEX_COLUMN]), properties: row });
    } catch (err) {
      failed += 1;
      if (failed === 1) console.warn("Could not build a hexagon from an H3 index", err);
    }
  }

  const capped = volumeNote(rows.length);
  const skipped = failed ? ` · ${failed} could not be built` : "";
  const note = coarse
    ? `${features.length.toLocaleString()} hexagons at res ${coarsenResolution}, rolled up from ` +
      `${rows.reduce((total, row) => total + Number(row.cells || 0), 0).toLocaleString()} cells${capped}${skipped}`
    : `${features.length.toLocaleString()} H3 cells${capped}${skipped}`;
  return { features, note, resolution: dataResolution };
}

/** Features for a view with a real geometry column. */
export async function geometryFeatures(viewName, columns, geometry, crs = LONLAT) {
  if (geometry.kind === "geometry" && !hasSpatial()) {
    // Without it, ST_AsWKB is not in the catalog and the query below fails with
    // a message about installing an extension, which is not the user's problem.
    return { features: [], note: "the spatial extension did not load" };
  }

  const attributeColumns = columns.filter((column) => column.name !== geometry.name).map((column) => qid(column.name));
  /*
   * A Reprojector upstream means these coordinates are not lon/lat, and
   * MapLibre only speaks lon/lat — so the stream comes home for drawing only.
   * The data itself is left where the user put it; this is the display copy.
   */
  const drawable = isLonLatCode(crs)
    ? wkbExpression(geometry)
    : `ST_AsWKB(ST_Transform(${geometryExpression(geometry)}, ${qlit(crs)}, ${qlit(LONLAT)}, always_xy := true))`;
  const selection = [`${drawable} AS _wkb`, ...attributeColumns].join(", ");
  const rows = await guardedRead(() =>
    query(`SELECT ${selection} FROM ${viewName} WHERE ${qid(geometry.name)} IS NOT NULL${limitClause()}`),
  );

  const features = [];
  let failed = 0;
  for (const row of rows) {
    const { _wkb: wkb, ...properties } = row;
    try {
      features.push({ type: "Feature", geometry: decodeWKB(wkb), properties });
    } catch (err) {
      failed += 1;
      if (failed === 1) console.warn("Could not decode a geometry", err);
    }
  }

  const bounds = boundsOf(features);
  if (bounds && !looksLikeLonLat(bounds)) {
    // A declared CRS is reprojected at the Reader and a Reprojector's is
    // undone just above, so reaching here means the file declared none — the
    // one case the app still cannot resolve on its own.
    return {
      features: [],
      note:
        `not longitude/latitude (x ${Math.round(bounds[0])}…${Math.round(bounds[2])}) and no CRS ` +
        "declared — set a CRS override on the Reader",
    };
  }

  const capped = volumeNote(rows.length);
  const skipped = failed ? ` · ${failed} could not be decoded` : "";
  return { features, note: `${features.length.toLocaleString()} features${capped}${skipped}` };
}
