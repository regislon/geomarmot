// @ts-check
import {
  defineTransformer,
  API_VERSION,
  param,
  qid,
  qlit,
  findGeometryColumn,
  geometryExpression,
  overlayFaces,
  MAX_OVERLAY_FEATURES,
  FEATURE_ID_COLUMN,
  throwIfAborted,
} from "../_kit/index.js";

const OVERLAP_COUNT_COLUMN = "_overlaps";
const REJECTION_COLUMN = "rejection_code";
const AMBIGUOUS = { DROP: "Drop and report", FAIL: "Fail" };
const INVALID = { REJECT: "Reject", REPAIR: "Repair" };

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "AreaOnAreaOverlayer",
  group: "Combine",
  summary: "Splits overlapping polygons into faces, counting and listing the polygons over each.",
  description:
    "AreaOnAreaOverlayer takes every polygon in its input, overlays them all at once, and returns one row " +
    "per atomic face of the result: the smallest pieces the boundaries cut the plane into. Each face " +
    "carries how many input polygons cover it and, for the attributes you choose, the distinct values of " +
    "those polygons joined by a separator. With an ID attribute (and optionally a layer attribute, for " +
    "several layers combined upstream), Memberships lists exactly which feature of which layer covers each " +
    "face. The partition is built with GEOS, compiled to WebAssembly and run in background workers: every " +
    "boundary is noded and polygonized, and a face's covering polygons are found from an interior point " +
    "certified to lie clear of the face's boundary. Faces too thin to certify are never guessed: they go to " +
    "Rejected. Overlaying all at once matters: pairwise overlays would count a triple overlap twice. It " +
    "works in longitude/latitude only.",
  whenToUse: [
    "find where plots overlap and by how many",
    "partition overlapping buffers into non-overlapping pieces",
    "list which zones cover each piece of land",
    "cross-reference two boundary layers: which unit of one covers which unit of the other",
  ],
  whenNotToUse: [
    "merging touching polygons into one — use Dissolver",
    "keeping only the shared area of two layers — write ST_Intersection in an SQLTransformer",
  ],
  keywords: [
    "overlay",
    "overlap",
    "intersect",
    "planar partition",
    "polygonize",
    "faces",
    "union overlay",
    "provenance",
    "crosswalk",
  ],
  examples: [
    {
      input: "two 2×2 squares overlapping in a 1×1 corner",
      params: "Accumulate = cat",
      output: "three faces: one with _overlaps 2 and cat A;B, two with _overlaps 1",
    },
    {
      input: "districts and parishes combined with Unioner, a layer column saying which",
      params: "Layer attribute = layer, ID attribute = code",
      output: "faces, and in Memberships one row per (face, layer, code) covering it",
    },
  ],
  inputs: [{ id: "input", label: "Input", description: "The polygons to overlay, in longitude/latitude." }],
  outputs: [
    {
      id: "output",
      label: "Output",
      description:
        "One row per face: its geometry, the overlap count, the accumulated attributes and, with an ID attribute, face_id.",
    },
    {
      id: "memberships",
      label: "Memberships",
      description:
        "With an ID attribute: one row per face and covering feature (face_id, layer, feature_id). Empty without one.",
    },
    {
      id: "rejected",
      label: "<Rejected>",
      description:
        "Input features that were not overlaid, and faces too thin to certify, with the reason in rejection_code.",
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
    param.column("idAttribute", "ID attribute", {
      description:
        "The attribute identifying each feature. When set, Memberships lists the features covering every face, " +
        "and features with no ID, or an ID used twice in the same layer, go to Rejected.",
    }),
    param.column("layerAttribute", "Layer attribute", {
      description:
        "The attribute saying which layer a feature belongs to, when several layers were combined upstream. " +
        "IDs need only be unique within a layer.",
    }),
    param.select("ambiguous", "Uncertain faces", {
      options: [
        { value: AMBIGUOUS.DROP, description: "Leave them out of the output and list them in Rejected." },
        { value: AMBIGUOUS.FAIL, description: "Stop with an error if there is any." },
      ],
      default: AMBIGUOUS.DROP,
      description:
        "Faces so thin that no interior point lies clear of their boundary, so which polygons cover them cannot " +
        "be certified. They are typically slivers between nearly coincident boundaries.",
    }),
    param.select("invalid", "Invalid polygons", {
      options: [
        { value: INVALID.REJECT, description: "Send them to Rejected." },
        { value: INVALID.REPAIR, description: "Repair them (ST_MakeValid) and overlay the result." },
      ],
      default: INVALID.REJECT,
      description: "What to do with input polygons that are self-intersecting or otherwise invalid geometry.",
    }),
  ],
  needs: { schema: true, lonLat: true },
  prepare: async (ctx) => {
    const geometry = findGeometryColumn(ctx.schemas?.input || []);
    if (!geometry) throw new Error("This input has no geometry to overlay.");
    ctx.state.geometry = geometry;
    const t = tables(ctx);
    // A table, so the ids the faces are matched against cannot be recomputed differently.
    await ctx.engine.exec(
      `CREATE OR REPLACE TABLE ${t.source} AS SELECT row_number() OVER () AS ${qid(FEATURE_ID_COLUMN)}, * FROM ${ctx.inputs.input}`,
    );
    const rows = Number((await ctx.engine.query(`SELECT count(*) AS n FROM ${t.source}`))[0]?.n ?? 0);
    const cap = ctx.limits?.overlayFeatures ?? MAX_OVERLAY_FEATURES;
    if (rows > cap) {
      throw new Error(
        `${rows.toLocaleString()} features is past the ${cap.toLocaleString()} ceiling for an overlay. Filter or dissolve upstream first.`,
      );
    }
    await ctx.engine.exec(rejectedRowsSql(t, ctx.params, geometry));
    await ctx.engine.exec(workSql(t, ctx.params, geometry));
    throwIfAborted(ctx.signal);
    const result = await overlayFaces(ctx.engine, {
      source: t.work,
      fid: qid(FEATURE_ID_COLUMN),
      geometry: qid(geometry.name),
      faces: t.faces,
      memberships: t.memberships,
      ambiguous: t.ambiguous,
      signal: ctx.signal,
    });
    if (result.ambiguous && ctx.params.ambiguous === AMBIGUOUS.FAIL) {
      throw new Error(
        `${result.ambiguous.toLocaleString()} face(s) are too thin to tell which polygons cover them. ` +
          `Choose "${AMBIGUOUS.DROP}" to list them in Rejected instead.`,
      );
    }
    throwIfAborted(ctx.signal);
  },
  sql: (ctx) => {
    const t = tables(ctx);
    return { output: outputSql(t, ctx), memberships: membershipsSql(t, ctx.params), rejected: rejectedSql(t, ctx) };
  },
});

function tables(ctx) {
  const names = ["source", "rejectedRows", "work", "faces", "memberships", "ambiguous"];
  return Object.fromEntries(names.map((name) => [name, ctx.tableName(name.toLowerCase())]));
}

const fid = qid(FEATURE_ID_COLUMN);

/** Trimmed text of an attribute, NULL when missing or blank. */
const idText = (column) => `NULLIF(TRIM(CAST(${qid(column)} AS VARCHAR)), '')`;

/** Input rows that are not overlaid, each with the first reason that applies. */
function rejectedRowsSql(t, params, geometry) {
  const geom = geometryExpression(geometry);
  const reasons = [`WHEN ${geom} IS NULL OR ST_IsEmpty(${geom}) THEN 'no_geometry'`];
  reasons.push(
    `WHEN NOT list_contains(list_transform(ST_Dump(${geom}), d -> ST_GeometryType(d.geom)::VARCHAR), 'POLYGON') THEN 'no_polygon'`,
  );
  if (params.idAttribute) {
    const layer = params.layerAttribute ? idText(params.layerAttribute) : "NULL";
    reasons.push(`WHEN ${idText(params.idAttribute)} IS NULL THEN 'missing_id'`);
    reasons.push(`WHEN count(*) OVER (PARTITION BY ${layer}, ${idText(params.idAttribute)}) > 1 THEN 'duplicate_id'`);
  }
  if (params.invalid !== INVALID.REPAIR) reasons.push(`WHEN NOT ST_IsValid(${geom}) THEN 'invalid_geometry'`);
  return (
    `CREATE OR REPLACE TABLE ${t.rejectedRows} AS SELECT * FROM (` +
    `SELECT *, CASE ${reasons.join(" ")} END AS ${qid(REJECTION_COLUMN)} FROM ${t.source}) ` +
    `WHERE ${qid(REJECTION_COLUMN)} IS NOT NULL`
  );
}

/** The rows that are overlaid: geometry as GEOMETRY, repaired when asked. */
function workSql(t, params, geometry) {
  const geom = geometryExpression(geometry);
  const value =
    params.invalid === INVALID.REPAIR
      ? `CASE WHEN ST_IsValid(${geom}) THEN ${geom} ELSE ST_MakeValid(${geom}) END`
      : geom;
  return (
    `CREATE OR REPLACE TABLE ${t.work} AS SELECT ${fid}, ${value} AS ${qid(geometry.name)} FROM ${t.source} ` +
    `WHERE ${fid} NOT IN (SELECT ${fid} FROM ${t.rejectedRows})`
  );
}

function outputSql(t, ctx) {
  const geometry = ctx.state.geometry;
  const separator = ctx.params.separator ?? ";";
  const count = qid(ctx.params.countAttribute || OVERLAP_COUNT_COLUMN);
  // Distinct and ordered, so two runs of the same graph produce the same string.
  const accumulated = (ctx.params.accumulate || [])
    .filter((name) => name && name !== geometry.name)
    .map((name) => `string_agg(DISTINCT s.${qid(name)}, ${qlit(separator)} ORDER BY s.${qid(name)}) AS ${qid(name)}`);
  const faceId = ctx.params.idAttribute ? ["f.face_id"] : [];
  const columns = [`f.geometry AS ${qid(geometry.name)}`, `count(*) AS ${count}`, ...accumulated, ...faceId];
  return (
    `SELECT ${columns.join(", ")} FROM ${t.faces} f JOIN ${t.memberships} m USING (face_id) ` +
    `JOIN ${t.source} s ON s.${fid} = m.fid GROUP BY f.face_id, f.geometry`
  );
}

function membershipsSql(t, params) {
  const layer = params.layerAttribute ? `CAST(s.${qid(params.layerAttribute)} AS VARCHAR)` : "CAST(NULL AS VARCHAR)";
  const id = params.idAttribute ? `CAST(s.${qid(params.idAttribute)} AS VARCHAR)` : "CAST(NULL AS VARCHAR)";
  return (
    `SELECT m.face_id, ${layer} AS layer, ${id} AS feature_id FROM ${t.memberships} m ` +
    `JOIN ${t.source} s ON s.${fid} = m.fid${params.idAttribute ? "" : " WHERE false"}`
  );
}

function rejectedSql(t, ctx) {
  const geometry = qid(ctx.state.geometry.name);
  return (
    `SELECT * EXCLUDE (${fid}) FROM ${t.rejectedRows} UNION ALL BY NAME ` +
    `SELECT geometry AS ${geometry}, 'ambiguous_face' AS ${qid(REJECTION_COLUMN)} FROM ${t.ambiguous}`
  );
}
