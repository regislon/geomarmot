// @ts-check
/*
 * Checking a generated transformer's spec before it is installed.
 *
 * Refused whole, with every problem listed, unless:
 *   - it matches schema.json, with unique ids and a free (or generated) id
 *   - params: select params have options; defaults parse and suit the kind
 *   - SQL steps: only {{inputs.x}}, {{steps.y}} (earlier steps) and {{params.z}}
 *     placeholders, and the rendered template passes the SQL guard in its
 *     "template" context — reading nothing but the relations it names
 *   - call steps: a reviewed, assistant-usable, built-in transformer (never a
 *     generated one); every input port wired once; params valid against its
 *     schema; every SQL fragment in them passes the guard, as a restricted node
 *   - outputs name existing steps and ports
 * The same guard runs again at every compile, with the node's own params.
 */

import { validate as validateSchema } from "../../core/jsonschema.js";
import { fragmentsOf, validate as guard } from "../../core/sqlguard/index.js";
import { placeholderFor, renderTemplate, tokens } from "../../core/template.js";
import { PALETTE_GROUPS, REGISTRY } from "../../../../transformers/index.js";
import { paramsSchemaFor } from "../catalogue.js";
import { classify, structured } from "../gate/index.js";
import { schemaProblem } from "../gate/errors.js";
import { callParams, parseFrom, specDefaults, stepOutputs } from "./runtime.js";
import specSchema from "./schema.json" with { type: "json" };

export { specSchema };

/** A stand-in value per kind, for checking a template whose param has no default. */
const SAMPLE = { string: "", number: 0, select: "", column: "x", columns: ["x"] };

/**
 * @param {any} spec
 * @returns {Promise<{ ok: boolean, problems: Array<{ node: string|null, param: string|null, error: any }> }>}
 */
export async function validateSpec(spec) {
  const problems = [];
  const fail = (where, code, params = {}) =>
    problems.push({ node: where, param: params.param ?? null, error: structured(code, params) });

  const schemaErrors = validateSchema(spec, specSchema);
  if (schemaErrors.length) {
    fail(null, "INVALID_INPUT", {
      param: schemaErrors[0].path.replace(/^\$\.?/, "") || "spec",
      problem: schemaProblem(schemaErrors),
    });
    return { ok: false, problems };
  }
  const existing = REGISTRY.get(spec.id);
  if (existing && !existing.generated) fail(null, "INVALID_INPUT", { param: "id" });
  for (const list of ["inputs", "outputs", "params", "steps"]) {
    const ids = spec[list].map((item) => item.id);
    if (new Set(ids).size !== ids.length) fail(null, "INVALID_INPUT", { param: list });
  }

  let defaults = {};
  try {
    defaults = specDefaults(spec);
  } catch {
    fail(null, "INVALID_INPUT", { param: "params" });
  }
  for (const p of spec.params) {
    if (p.kind === "select" && !p.options.length) fail(null, "INVALID_INPUT", { param: `params.${p.id}` });
  }
  const values = Object.fromEntries(spec.params.map((p) => [p.id, defaults[p.id] ?? SAMPLE[p.kind]]));
  const inputIds = new Set(spec.inputs.map((i) => i.id));
  const earlier = new Set();
  const stepParams = new Map();

  for (const step of spec.steps) {
    if (step.kind === "sql") {
      if (!step.template.trim()) {
        fail(step.id, "INVALID_INPUT", { param: "template" });
      } else {
        await checkTemplate(step, spec, { inputIds, earlier, values, fail });
      }
    } else {
      await checkCall(step, { spec, inputIds, earlier, values, stepParams, fail });
    }
    earlier.add(step.id);
  }

  for (const output of spec.outputs) {
    const ref = parseFrom(output.from);
    if (!earlier.has(ref.step)) fail(null, "UNKNOWN_NODE", { node: ref.step });
    else if (ref.port && !stepOutputs(spec, ref.step, stepParams.get(ref.step)).includes(ref.port))
      fail(null, "UNKNOWN_PORT", { node: ref.step, port: ref.port });
  }
  return { ok: problems.length === 0, problems };
}

async function checkTemplate(step, spec, { inputIds, earlier, values, fail }) {
  let found;
  try {
    found = tokens(step.template);
  } catch {
    fail(step.id, "SQL_FORBIDDEN_CONSTRUCT", { construct: "{{", rule: "TEMPLATE" });
    return;
  }
  let ok = true;
  for (const token of found) {
    if (token.space === "inputs" && !inputIds.has(token.name)) {
      fail(step.id, "UNKNOWN_PORT", { node: step.id, port: token.name });
      ok = false;
    }
    if (token.space === "steps" && !earlier.has(token.name)) {
      fail(step.id, "UNKNOWN_NODE", { node: token.name });
      ok = false;
    }
    if (token.space === "params" && !spec.params.some((p) => p.id === token.name)) {
      fail(step.id, "INVALID_PARAMS", { param: token.name });
      ok = false;
    }
  }
  if (!ok) return;
  const relations = [...new Set(found.filter((t) => t.space !== "params").map((t) => placeholderFor(t.space, t.name)))];
  let rendered;
  try {
    rendered = renderTemplate(step.template, { relation: placeholderFor, params: values, specs: spec.params });
  } catch {
    fail(step.id, "INVALID_PARAMS", { param: "template" });
    return;
  }
  const verdict = await guard(rendered, "template", { relations });
  if (!verdict.ok) refuse(fail, step.id, verdict);
}

async function checkCall(step, { spec, inputIds, earlier, values, stepParams, fail }) {
  const called = REGISTRY.get(step.transformer);
  if (!called || !PALETTE_GROUPS.includes(called.group) || called.generated) {
    fail(step.id, "UNKNOWN_TRANSFORMER", { transformer: step.transformer });
    return;
  }
  if (!called.aiUsable) {
    fail(step.id, "NOT_AI_USABLE", { transformer: step.transformer });
    return;
  }
  let params;
  try {
    params = callParams(step, values);
  } catch {
    fail(step.id, "INVALID_INPUT", { param: "params_json" });
    return;
  }
  const written = step.params_json?.trim() ? JSON.parse(step.params_json) : {};
  const schemaErrors = validateSchemaLoosely(written, paramsSchemaFor(step.transformer), spec);
  if (schemaErrors) fail(step.id, "INVALID_PARAMS", { param: schemaErrors, transformer: step.transformer });
  stepParams.set(step.id, params);
  const wired = step.inputs.map((wire) => wire.port);
  for (const port of called.inputs)
    if (!wired.includes(port.id)) fail(step.id, "PORT_NOT_CONNECTED", { port: port.id });
  if (new Set(wired).size !== wired.length || wired.some((port) => !called.inputs.some((p) => p.id === port)))
    fail(step.id, "INVALID_INPUT", { param: "inputs" });
  for (const wire of step.inputs) {
    const ref = parseFrom(wire.from);
    if ("input" in ref ? !inputIds.has(ref.input) : !earlier.has(ref.step))
      fail(step.id, "UNKNOWN_NODE", { node: "input" in ref ? ref.input : ref.step });
  }
  // A call step is a restricted node: its SQL-bearing params are guarded like any other.
  for (const fragment of fragmentsOf(called, params)) {
    const verdict = await guard(fragment.sql, fragment.context);
    if (!verdict.ok) refuse(fail, step.id, verdict);
  }
}

/** The first schema problem of a call step's params, with "{{params.x}}" tokens accepted in place of any value. */
function validateSchemaLoosely(written, schema, spec) {
  const tokenIds = new Set(spec.params.map((p) => `{{params.${p.id}}}`));
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip).filter((v) => v !== undefined);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .map(([k, v]) => [k, strip(v)])
          .filter(([, v]) => v !== undefined),
      );
    return typeof value === "string" && tokenIds.has(value.replace(/\s+/g, "")) ? undefined : value;
  };
  const errors = validateSchema(strip(written), schema);
  return errors.length ? errors[0].path.replace(/^\$\.?/, "").split(/[.[]/)[0] || "params" : null;
}

function refuse(fail, stepId, verdict) {
  const error = classify({ code: verdict.code, message: verdict.message });
  fail(stepId, error.code, error.params);
}
