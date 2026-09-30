// @ts-check
/*
 * Factories for the geometry transformers that share one shape: replace each
 * feature's geometry with a function of it, attributes riding along.
 *
 * sqlGeometryTool: the function is a DuckDB spatial expression.
 * jsGeometryTool:  the function runs in JSTS; the rows are materialised with an
 *                  id first, so the results join back to exactly the rows they
 *                  came from.
 */

import { qid } from "../../app/src/core/duck.js";
import { findGeometryColumn, geometryExpression } from "../../app/src/core/schema.js";
import { createShapeTable, exec, query, throwIfAborted } from "./engine.js";
import { FEATURE_ID_COLUMN } from "./helpers.js";

const GEOMETRY_IN = [{ id: "input", label: "Input", description: "Rows with a geometry column." }];

/**
 * @param {object} spec  a defineTransformer spec without sql, plus:
 *   build(sourceExpr, params, geometry) → the new geometry expression;
 *   collapses(params) → true when the result is one row for the whole input (an aggregate).
 */
export function sqlGeometryTool({ build, collapses = () => false, outputDescription, ...spec }) {
  return {
    group: "Geometry",
    inputs: GEOMETRY_IN,
    outputs: [
      { id: "output", label: "Output", description: outputDescription || "The rows with each geometry replaced." },
    ],
    needs: { schema: true },
    ...spec,
    sql: (ctx) => {
      const geometry = findGeometryColumn(ctx.schemas?.input || []);
      if (!geometry) throw new Error(`${spec.id} needs a geometry column.`);
      const column = qid(geometry.name);
      const shaped = build(geometryExpression(geometry), ctx.params, geometry);
      // An aggregate cannot sit beside `*` in one SELECT.
      return {
        output: collapses(ctx.params)
          ? `SELECT ${shaped} AS ${column} FROM ${ctx.inputs.input}`
          : `SELECT * EXCLUDE (${column}), ${shaped} AS ${column} FROM ${ctx.inputs.input}`,
      };
    },
  };
}

/**
 * @param {object} spec  a defineTransformer spec without sql/prepare, plus:
 *   operation — the JSTS operation name in app/src/engines/jsts.js (defaults to spec.id);
 *   options(params) → options for that operation (validated; throw to refuse).
 */
export function jsGeometryTool({ operation, options = () => ({}), outputDescription, ...spec }) {
  return {
    group: "Geometry",
    inputs: GEOMETRY_IN,
    outputs: [
      { id: "output", label: "Output", description: outputDescription || "The rows with each geometry replaced." },
    ],
    needs: { schema: true },
    ...spec,
    prepare: async (ctx) => {
      const geometry = findGeometryColumn(ctx.schemas?.input || []);
      if (!geometry) throw new Error(`${spec.id} needs a geometry column.`);
      ctx.state.geometry = geometry;
      const source = ctx.tableName("src");
      const shapes = ctx.tableName("shape");
      await exec(
        `CREATE OR REPLACE TABLE ${source} AS SELECT row_number() OVER () AS ${qid(FEATURE_ID_COLUMN)}, * FROM ${ctx.inputs.input}`,
      );
      const rows = await query(
        `SELECT ${qid(FEATURE_ID_COLUMN)} AS fid, ST_AsText(${geometryExpression(geometry)}) AS wkt FROM ${source} WHERE ${qid(geometry.name)} IS NOT NULL`,
      );
      throwIfAborted(ctx.signal);
      await createShapeTable(rows, operation || spec.id, options(ctx.params), shapes);
      throwIfAborted(ctx.signal);
    },
    sql: (ctx) => {
      const column = qid(ctx.state.geometry.name);
      // LEFT JOIN, so a row whose geometry was NULL survives with a NULL shape.
      return {
        output:
          `SELECT s.* EXCLUDE (${qid(FEATURE_ID_COLUMN)}, ${column}), g.geometry AS ${column} ` +
          `FROM ${ctx.tableName("src")} s LEFT JOIN ${ctx.tableName("shape")} g ON s.${qid(FEATURE_ID_COLUMN)} = g.fid`,
      };
    },
  };
}
