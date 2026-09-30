// @ts-check
/*
 * defineTransformer: the one way a transformer enters the registry.
 *
 * It checks the declaration's shape, fills in defaults and returns a frozen
 * object. The full contract — every field, every hook, the order the compiler
 * calls them in and what each may do — is docs/transformer-api.md.
 */

import { KINDS } from "./params.js";

export const API_VERSION = 1;
const ROLES = new Set(["transform", "source", "sink"]);
const HOOKS = ["sql", "crs", "prepare", "check", "write"];

/**
 * @typedef {{ id: string, label: string, description?: string }} Port
 * @typedef {import("./params.js").ParamSpec} ParamSpec
 *
 * @typedef {object} TransformerSpec
 * @property {number} apiVersion
 * @property {string} id                  stable; the type saved in graphs
 * @property {string} [name]              display name (defaults to id)
 * @property {string} group
 * @property {"transform"|"source"|"sink"} [role]
 * @property {string} summary
 * @property {string} [description]
 * @property {string[]} [whenToUse]
 * @property {string[]} [whenNotToUse]
 * @property {string[]} [keywords]
 * @property {Array<{input: string, params: string, output: string}>} [examples]
 * @property {Port[]} [inputs]
 * @property {Port[] | ((params: any) => Port[])} [outputs]
 * @property {ParamSpec[]} [params]
 * @property {number} [paramsVersion]
 * @property {Record<number, (params: any) => any>} [migrations]
 * @property {string[]} [aliases]
 * @property {{schema?: boolean, rowCount?: boolean, lonLat?: boolean}} [needs]
 * @property {(ctx: any) => Record<string, string>} [sql]
 * @property {(ctx: any) => string} [crs]
 * @property {(ctx: any) => Promise<void>} [prepare]
 * @property {(ctx: any) => Promise<void>} [check]
 * @property {(ctx: any) => Promise<{files: any[], note?: string|null}>} [write]
 * @property {{id: string, label: string}} [action]
 * @property {boolean} [aiUsable]
 * @property {any} [help]
 */

function fail(id, message) {
  throw new Error(`Transformer ${id || "(unnamed)"}: ${message}`);
}

/** @param {TransformerSpec} spec */
export function defineTransformer(spec) {
  const id = spec?.id;
  if (!id || !/^[A-Z][A-Za-z0-9]*$/.test(id)) fail(id, "id must be PascalCase letters and digits.");
  if (spec.apiVersion !== API_VERSION) fail(id, `apiVersion must be ${API_VERSION}.`);
  const role = spec.role || "transform";
  if (!ROLES.has(role)) fail(id, `role must be one of ${[...ROLES].join(", ")}.`);
  if (!spec.group) fail(id, "group is required.");
  if (!spec.summary) fail(id, "summary is required.");
  const inputs = spec.inputs || [];
  const params = spec.params || [];
  for (const hook of HOOKS) {
    if (spec[hook] !== undefined && typeof spec[hook] !== "function") fail(id, `${hook} must be a function.`);
  }
  for (const p of params) {
    if (!p.id || !p.label) fail(id, "every param needs an id and a label.");
    if (!KINDS[p.kind]) fail(id, `param ${p.id}: unknown kind "${p.kind}".`);
  }
  if (new Set(params.map((p) => p.id)).size !== params.length) fail(id, "param ids must be unique.");
  if (new Set(inputs.map((p) => p.id)).size !== inputs.length) fail(id, "input port ids must be unique.");

  const outputs = spec.outputs ?? [];
  const outputsFor = typeof outputs === "function" ? outputs : () => outputs;
  if (role === "source" && inputs.length) fail(id, "a source has no inputs.");
  if (role === "sink") {
    if (typeof outputs !== "function" && outputs.length) fail(id, "a sink has no outputs.");
    if (!spec.write) fail(id, "a sink must define write(ctx).");
  } else if (!spec.sql) {
    fail(id, "sql(ctx) is required.");
  }

  const paramsVersion = spec.paramsVersion ?? 1;
  const migrations = spec.migrations || {};
  for (let v = 1; v < paramsVersion; v++) {
    if (typeof migrations[v] !== "function")
      fail(id, `migrations[${v}] is missing (paramsVersion is ${paramsVersion}).`);
  }

  return Object.freeze({
    apiVersion: API_VERSION,
    id,
    name: spec.name || id,
    // The inspector and palette still say `label` and `hint`.
    label: spec.name || id,
    hint: spec.summary,
    group: spec.group,
    role,
    summary: spec.summary,
    description: spec.description || "",
    whenToUse: spec.whenToUse || [],
    whenNotToUse: spec.whenNotToUse || [],
    keywords: spec.keywords || [],
    examples: spec.examples || [],
    inputs,
    outputsFor: (params) => (role === "sink" ? [] : outputsFor(params || {})),
    params,
    paramsVersion,
    migrations,
    aliases: spec.aliases || [],
    needs: { schema: false, rowCount: false, lonLat: false, ...(spec.needs || {}) },
    sql: spec.sql || null,
    crs: spec.crs || null,
    prepare: spec.prepare || null,
    check: spec.check || null,
    write: spec.write || null,
    action: spec.action || null,
    aiUsable: spec.aiUsable ?? !["source", "sink"].includes(role),
    help: spec.help || null,
  });
}
