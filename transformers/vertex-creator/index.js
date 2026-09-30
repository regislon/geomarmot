// @ts-check
import { defineTransformer, API_VERSION, param, SINGLE_IN } from "../_kit/index.js";
import { vertexCreatorSql, VERTEX_MODES, VERTEX_Z_CONFLICT } from "./sql.js";

const mode = (node) => node.params.mode || "Add Point";

export default defineTransformer({
  apiVersion: API_VERSION,
  group: "Geometry",
  id: "VertexCreator",
  summary: "Adds, inserts or replaces one vertex, or turns coordinate columns into points.",
  description:
    "VertexCreator creates one vertex from an X, a Y and an optional Z value — each a constant, an " +
    "attribute, a formula or SQL — and puts it into every feature's geometry. Add Point appends it " +
    "(nothing becomes a point, a point a line, a line a longer line or, once it closes, a polygon). Replace " +
    "with Point throws the geometry away for the new point, which is how a table of coordinates becomes a " +
    "layer, and can label the stream with a coordinate system. Insert and Replace Point at Index work at a " +
    "position, counted from 0, with negatives from the end and out-of-range values clamped. Z conflicts " +
    "are resolved by rule, and features a mode cannot handle go to Rejected with a reason.",
  whenToUse: [
    "turn lon/lat columns into points",
    "make Swiss E/N columns into points labelled EPSG:2056",
    "close a line into a polygon by adding its first point",
    "move one vertex of every feature",
  ],
  whenNotToUse: [
    "building any other geometry from attributes — write the expression in an AttributeCreator",
    "editing multi-part features — split them first",
  ],
  keywords: [
    "points from coordinates",
    "xy to point",
    "make point",
    "vertex",
    "add point",
    "geocode",
    "lon lat",
    "insert vertex",
  ],
  examples: [
    {
      input: "rows with lon and lat",
      params: "Replace with Point, X = lon, Y = lat, Remove Attributes = Yes",
      output: "points, without the lon and lat columns",
    },
    { input: "LINESTRING (0 0, 1 0, 1 1)", params: "Add Point at (0 0)", output: "POLYGON ((0 0, 1 0, 1 1, 0 0))" },
  ],
  inputs: SINGLE_IN,
  outputs: [
    { id: "output", label: "Output", description: "The features with the vertex applied." },
    {
      id: "rejected",
      label: "<Rejected>",
      description: "Features the mode cannot handle, untouched, with the reason in rejection_code.",
    },
  ],
  params: [
    param.select("mode", "Mode", {
      options: [
        { value: "Add Point", description: "Append the vertex to the feature." },
        { value: "Replace with Point", description: "Discard the geometry; the feature becomes the new point." },
        { value: "Insert Point at Index", description: "Insert the vertex before the vertex at the index." },
        { value: "Replace Point at Index", description: "Replace the vertex at the index." },
      ].filter((option) => VERTEX_MODES.includes(option.value)),
      default: "Add Point",
      description: "What to do with the new vertex: append it, replace the geometry with it, or put it at an index.",
    }),
    param.valuespec("x", "X Value", {
      description: "The new vertex's X (longitude or easting): a constant, an attribute, a formula or SQL.",
    }),
    param.valuespec("y", "Y Value", {
      description: "The new vertex's Y (latitude or northing): a constant, an attribute, a formula or SQL.",
    }),
    param.valuespec("z", "Z Value (optional)", {
      description: "The new vertex's Z, if any; leave empty for a two-dimensional vertex.",
    }),
    param.valuespec("index", "Index", {
      description: "The position to insert at or replace, counted from 0; negative counts back from the last vertex.",
      when: (node) => mode(node).endsWith("at Index"),
    }),
    param.string("crs", "Coordinate System", {
      placeholder: "blank keeps the stream's; EPSG:2056…",
      description:
        "For Replace with Point: the coordinate system the new points are in, which labels the stream below.",
      when: (node) => node.params.mode === "Replace with Point",
    }),
    param.select("removeAttributes", "Remove Attributes", {
      options: [
        { value: "No", description: "Keep every attribute." },
        { value: "Yes", description: "Drop the attributes the X, Y and Z values were read from." },
      ],
      default: "No",
      description: "Whether the attributes the coordinates came from are dropped once they are in the geometry.",
    }),
    param.select("zConflict", "Measures/Z Conflict Value", {
      options: [
        { value: "Compute", description: "Interpolate the missing Z, or give every vertex the new vertex's Z." },
        { value: "None (Drop Values)", description: "Drop Z when the input and the new vertex disagree." },
        { value: "Custom Value", description: "Fill missing Z with the Custom Z value." },
      ].filter((option) => VERTEX_Z_CONFLICT.includes(option.value)),
      default: "Compute",
      description: "How to resolve a feature and a new vertex that disagree about having a Z coordinate.",
      when: (node) => node.params.mode !== "Replace with Point",
    }),
    param.string("zCustom", "Custom Z", {
      default: "0",
      description: "The Z value given to vertices that have none, when the Z conflict rule is Custom Value.",
      when: (node) => node.params.mode !== "Replace with Point" && node.params.zConflict === "Custom Value",
    }),
    param.select("ignoreDuplicates", "Ignore Duplicated Coordinates", {
      options: [
        { value: "Yes", description: "Do not append a vertex equal to the last one." },
        { value: "No", description: "Append it anyway." },
      ],
      default: "Yes",
      description: "For Add Point: whether a new vertex at the same place as the last vertex is skipped.",
      when: (node) => mode(node) === "Add Point",
    }),
    param.select("closedLines", "Closed Line Handling", {
      options: [
        {
          value: "Create Polygon",
          description: "A line whose ends meet, with at least three corners, becomes a polygon.",
        },
        { value: "Create Line", description: "It stays a closed line." },
      ],
      default: "Create Polygon",
      description: "What a line becomes when the edit makes its first and last vertices meet.",
      when: (node) => node.params.mode !== "Replace with Point",
    }),
  ],
  help: {
    title: "VertexCreator",
    intro: [
      "Creates one vertex at the X, Y and optional Z Value — each a constant, an attribute, a formula or SQL. " +
        "Add Point appends it; Replace with Point throws the geometry away for a point, which is how a table " +
        "of coordinates becomes a layer; Insert and Replace Point at Index put it at a position.",
      "Indexes count from 0 at the first vertex; -1 is the last and other negatives count back from it; " +
        "out-of-range values clamp to the ends. On a polygon they count the exterior ring's corners, and the " +
        "ring is closed again afterwards.",
      "Features the mode cannot handle go to <Rejected> untouched, with the reason in rejection_code.",
    ],
  },
  needs: { schema: true },
  // A new point in a named CRS is the one case where the stream changes CRS.
  crs: (ctx) =>
    ctx.params.mode === "Replace with Point" && (ctx.params.crs || "").trim() ? ctx.params.crs.trim() : ctx.incomingCrs,
  sql: (ctx) => vertexCreatorSql(ctx.params, ctx.inputs.input, ctx.schemas?.input || []),
});
