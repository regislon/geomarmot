// @ts-check
import {
  defineTransformer,
  API_VERSION,
  param,
  qid,
  qlit,
  exec,
  query,
  findGeometryColumn,
  geometryExpression,
  createFaceTable,
  MAX_OVERLAY_FEATURES,
  FEATURE_ID_COLUMN,
  throwIfAborted,
} from "../_kit/index.js";

const OVERLAP_COUNT_COLUMN = "_overlaps";

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "AreaOnAreaOverlayer",
  group: "Combine",
  summary: "Splits overlapping polygons into faces, counting and merging the polygons over each.",
  description:
    "AreaOnAreaOverlayer takes every polygon in its input, overlays them all at once, and returns one row " +
    "per atomic face of the result: the smallest pieces the boundaries cut the plane into. Each face " +
    "carries how many input polygons cover it and, for the attributes you choose, the distinct values of " +
    "those polygons joined by a separator. The partition is built by noding every boundary and " +
    "polygonizing it — in JavaScript, with JSTS, because DuckDB-Wasm has no ST_Node or ST_Polygonize — and " +
    "a face's covering polygons are found by its interior point. Overlaying all at once matters: pairwise " +
    "overlays would count a triple overlap twice. It works in longitude/latitude only.",
  whenToUse: [
    "find where plots overlap and by how many",
    "partition overlapping buffers into non-overlapping pieces",
    "list which zones cover each piece of land",
  ],
  whenNotToUse: [
    "merging touching polygons into one — use Dissolver",
    "keeping only the shared area of two layers — write ST_Intersection in an SQLTransformer",
  ],
  keywords: ["overlay", "overlap", "intersect", "planar partition", "polygonize", "faces", "union overlay"],
  examples: [
    {
      input: "two 2×2 squares overlapping in a 1×1 corner",
      params: "Accumulate = cat",
      output: "three faces: one with _overlaps 2 and cat A;B, two with _overlaps 1",
    },
  ],
  inputs: [{ id: "input", label: "Input", description: "The polygons to overlay, in longitude/latitude." }],
  outputs: [
    {
      id: "output",
      label: "Output",
      description: "One row per face: its geometry, the overlap count and the accumulated attributes.",
    },
  ],
  params: [
    param.string("countAttribute", "Overlap count", {
      default: OVERLAP_COUNT_COLUMN,
      description: "The name of the attribute that holds how many input polygons cover each face.",
    }),
    param.columns("accumulate", "Accumulate attributes", {
      description: "Attributes whose distinct values, from every polygon covering a face, are joined onto that face.",
    }),
    param.string("separator", "List separator", {
      default: ";",
      description:
        "The text placed between accumulated values, which are sorted so repeated runs give the same string.",
    }),
  ],
  needs: { schema: true, lonLat: true },
  prepare: async (ctx) => {
    const geometry = findGeometryColumn(ctx.schemas?.input || []);
    if (!geometry) throw new Error("This input has no geometry to overlay.");
    const source = ctx.tableName("src");
    const faces = ctx.tableName("faces");
    ctx.state.geometry = geometry;
    // A table, so the ids the faces are matched against cannot be recomputed differently.
    await exec(
      `CREATE OR REPLACE TABLE ${source} AS SELECT row_number() OVER () AS ${qid(FEATURE_ID_COLUMN)}, * FROM ${ctx.inputs.input}`,
    );
    const rows = Number((await query(`SELECT count(*) AS n FROM ${source}`))[0]?.n ?? 0);
    if (rows > MAX_OVERLAY_FEATURES) {
      throw new Error(
        `${rows.toLocaleString()} features is past the ${MAX_OVERLAY_FEATURES.toLocaleString()} ceiling for an overlay. Filter or dissolve upstream first.`,
      );
    }
    const wkts = await query(
      `SELECT ST_AsText(${geometryExpression(geometry)}) AS wkt FROM ${source} WHERE ${qid(geometry.name)} IS NOT NULL`,
    );
    throwIfAborted(ctx.signal);
    await createFaceTable(wkts.map((row) => row.wkt).filter(Boolean), faces);
    throwIfAborted(ctx.signal);
  },
  sql: (ctx) => {
    const geometry = ctx.state.geometry;
    const source = ctx.tableName("src");
    const faces = ctx.tableName("faces");
    const separator = ctx.params.separator ?? ";";
    const count = qid(ctx.params.countAttribute || OVERLAP_COUNT_COLUMN);
    // Distinct and ordered, so two runs of the same graph produce the same string.
    const accumulated = (ctx.params.accumulate || [])
      .filter((name) => name && name !== geometry.name)
      .map((name) => `string_agg(DISTINCT s.${qid(name)}, ${qlit(separator)} ORDER BY s.${qid(name)}) AS ${qid(name)}`);
    // ST_Contains on the face's interior point: never picks up a neighbour that merely shares an edge.
    return {
      output:
        `SELECT f.geometry AS ${qid(geometry.name)}, count(*) AS ${count}${accumulated.length ? ", " + accumulated.join(", ") : ""} ` +
        `FROM ${faces} f JOIN ${source} s ON ST_Contains(s.${qid(geometry.name)}, f.point) GROUP BY f.face_id, f.geometry`,
    };
  },
});
