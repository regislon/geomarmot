// @ts-check
import {
  defineTransformer,
  API_VERSION,
  param,
  qid,
  exec,
  query,
  findGeometryColumn,
  geometryExpression,
  createPolygonFillTable,
  FEATURE_ID_COLUMN,
  FILL_MODES,
  H3_INDEX_COLUMN,
} from "../_kit/index.js";

const MODE_DESCRIPTIONS = {
  ContainsCentroid: "A cell is taken when its centroid is inside the polygon.",
  ContainsBoundary: "A cell is taken when it lies wholly inside the polygon.",
  Covers: "A cell is taken when it overlaps the polygon at all.",
  CoversBoundingBox: "A cell is taken when it overlaps the polygon's bounding box.",
};

export default defineTransformer({
  apiVersion: API_VERSION,
  group: "H3",
  id: "PolygonToH3",
  summary: "Fills polygons with H3 cells: one row per cell, carrying its polygon's attributes.",
  description:
    "PolygonToH3 covers every polygon with H3 cells at the resolution you choose and returns one row per " +
    "cell, carrying the polygon's attributes, the cell's h3_index and, by default, the cell's hexagon as " +
    "geometry (the polygon itself is dropped). Which cells count depends on the fill mode, named as h3ronpy " +
    "names them: centroid inside, wholly inside, overlapping, or overlapping the bounding box — each a " +
    "superset of the one before. The fill runs in JavaScript with h3-js, since DuckDB-Wasm has no H3 " +
    "extension. Input must be longitude/latitude polygons; a fill is capped at two million cells.",
  whenToUse: [
    "grid farms onto H3 cells at resolution 9",
    "aggregate polygon attributes to a hexagon grid",
    "count how many cells each region covers",
  ],
  whenNotToUse: [
    "cells for points — ST functions in an AttributeCreator, or a dense tile's PositionalH3Index",
    "hexagons for an existing index column — use H3GeometryFromIndex",
  ],
  keywords: ["h3", "polyfill", "hexagons", "grid", "tessellate", "cells", "polygon to cells"],
  examples: [
    {
      input: "one small polygon near Zurich",
      params: "Resolution 7, ContainsCentroid",
      output: "one row per resolution-7 cell whose centre is inside, with its hexagon",
    },
  ],
  inputs: [{ id: "input", label: "Input", description: "Polygons in longitude/latitude." }],
  outputs: [
    {
      id: "output",
      label: "Output",
      description: "One row per (polygon, cell): the polygon's attributes, the index and the hexagon.",
    },
  ],
  params: [
    param.select("resolution", "Resolution", {
      options: Array.from({ length: 16 }, (_, r) => ({ value: String(r), description: `H3 resolution ${r}.` })),
      default: "7",
      coverage: "one",
      description: "The H3 resolution of the cells, from 0 (continent-sized) to 15 (under a square metre).",
    }),
    param.select("mode", "Polygon fill mode", {
      options: Object.keys(FILL_MODES).map((value) => ({ value, description: MODE_DESCRIPTIONS[value] || value })),
      default: "ContainsCentroid",
      description: "Which cells count as covering a polygon, from the strictest to the most generous.",
    }),
    param.string("indexColumn", "Index attribute", {
      default: H3_INDEX_COLUMN,
      description: "The name of the attribute that holds each row's H3 cell index.",
    }),
    param.select("geometry", "Geometry", {
      options: [
        { value: "Hexagons", description: "Each row's geometry is its cell's hexagon." },
        { value: "None (index only)", description: "No geometry; only the index." },
      ],
      default: "Hexagons",
      description: "Whether each output row carries its cell's hexagon as geometry, or just the index.",
    }),
  ],
  needs: { schema: true, lonLat: true },
  prepare: async (ctx) => {
    const geometry = findGeometryColumn(ctx.schemas?.input || []);
    if (!geometry) throw new Error("This input has no geometry to fill.");
    ctx.state.geometry = geometry;
    const source = ctx.tableName("src");
    // A table, not a view: the ids must not be recomputed between this read and the join.
    await exec(
      `CREATE OR REPLACE TABLE ${source} AS SELECT row_number() OVER () AS ${qid(FEATURE_ID_COLUMN)}, * FROM ${ctx.inputs.input}`,
    );
    const rows = await query(
      `SELECT ${qid(FEATURE_ID_COLUMN)} AS fid, ST_AsGeoJSON(${geometryExpression(geometry)}) AS geojson FROM ${source}`,
    );
    await createPolygonFillTable(
      rows,
      Number(ctx.params.resolution ?? 7),
      ctx.params.mode || "ContainsCentroid",
      ctx.tableName("fill"),
      {
        signal: ctx.signal,
      },
    );
  },
  sql: (ctx) => {
    const geometry = ctx.state.geometry;
    const drop = [FEATURE_ID_COLUMN, geometry.name].map(qid).join(", ");
    const shape = (ctx.params.geometry ?? "Hexagons") === "Hexagons" ? `, f.geometry AS ${qid(geometry.name)}` : "";
    return {
      output:
        `SELECT s.* EXCLUDE (${drop}), f.cell AS ${qid(ctx.params.indexColumn || H3_INDEX_COLUMN)}${shape} ` +
        `FROM ${ctx.tableName("src")} s JOIN ${ctx.tableName("fill")} f ON s.${qid(FEATURE_ID_COLUMN)} = f.fid`,
    };
  },
});
