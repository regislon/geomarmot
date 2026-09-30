// @ts-check
/*
 * A generated transformer from its spec (Mode B).
 *
 * The transformer the graph sees has the spec's ports and params, and an
 * `expand(node)` the compiler calls instead of compiling it
 * (core/graph/expand.js). Each SQL step becomes an internal TemplateStep
 * transformer, `<Id>Step<Step>`, whose SQL is the template rendered with typed
 * params (core/template.js) and whose template is checked by the SQL guard at
 * every compile. Each call step becomes a node of the called transformer, with
 * this node's params substituted where the spec says `"{{params.x}}"`. None of
 * them ever carries a sqlMode, so they are always restricted.
 */

import { API_VERSION, defineTransformer, param } from "../../../../transformers/_kit/index.js";
import { REGISTRY, defaultParams, registerInternal } from "../../../../transformers/index.js";
import { placeholderFor, renderTemplate, tokens } from "../../core/template.js";

/** "steps.a" → { step: "a" }, "steps.a.passed" → { step: "a", port: "passed" }, "inputs.x" → { input: "x" }. */
export function parseFrom(text) {
  const [space, name, port] = String(text).split(".");
  return space === "inputs" ? { input: name } : { step: name, ...(port && { port }) };
}

/** The output port a step reference means when it names no port: a SQL step's only port, a call's first. */
export function stepOutputs(spec, stepId, params) {
  const step = spec.steps.find((s) => s.id === stepId);
  if (!step) return [];
  if (step.kind === "sql") return ["output"];
  const called = REGISTRY.get(step.transformer);
  return called ? called.outputsFor(params).map((p) => p.id) : [];
}

/** The internal type of a SQL step: CustomAdults + keep_rows → CustomAdultsStepKeepRows. */
export const stepType = (spec, step) =>
  `${spec.id}Step${step.id
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}`;

const PARAM_TOKEN = /^\{\{\s*params\.([A-Za-z0-9_]+)\s*\}\}$/;

/**
 * A call step's params: its JSON, with every string that is exactly "{{params.x}}"
 * replaced by this node's param x. A token inside a longer string is not allowed.
 */
export function callParams(step, values) {
  const parsed = step.params_json?.trim() ? JSON.parse(step.params_json) : {};
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    if (typeof value !== "string") return value;
    const match = value.match(PARAM_TOKEN);
    if (match) return structuredClone(values?.[match[1]] ?? null);
    if (/\{\{|\}\}/.test(value)) throw new Error(`A call step's params may only use "{{params.x}}" as a whole value.`);
    return value;
  };
  return { ...defaultParams(step.transformer), ...walk(parsed) };
}

/** The default of each spec param, parsed. */
export function specDefaults(spec) {
  return Object.fromEntries(
    spec.params.filter((p) => p.default_json?.trim()).map((p) => [p.id, JSON.parse(p.default_json)]),
  );
}

function kitParams(spec) {
  return spec.params.map((p) =>
    param[p.kind](p.id, p.label, {
      description: p.description,
      ...(p.kind === "select" && { options: p.options.map((value) => ({ value, description: value })) }),
      ...(p.default_json?.trim() && { default: JSON.parse(p.default_json) }),
    }),
  );
}

/** The input ports of a SQL step: one per input or step its template reads. */
function templatePorts(step) {
  const seen = new Set();
  const ports = [];
  for (const token of tokens(step.template)) {
    if (token.space === "params") continue;
    const id = `${token.space === "inputs" ? "in" : "step"}_${token.name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    ports.push({ id, label: `${token.space}.${token.name}`, token });
  }
  return ports;
}

function templateStep(spec, step) {
  const ports = templatePorts(step);
  const specs = spec.params.map(({ id, kind }) => ({ id, kind }));
  const portFor = (space, name) => `${space === "inputs" ? "in" : "step"}_${name}`;
  return defineTransformer({
    apiVersion: API_VERSION,
    id: stepType(spec, step),
    group: "Internal",
    summary: `Step ${step.id} of the generated transformer ${spec.id}.`,
    inputs: ports.map(({ id, label }) => ({ id, label, description: label })),
    outputs: [{ id: "output", label: "Output", description: "The step's result." }],
    params: kitParams(spec),
    aiUsable: false,
    // What the guard validates: the template with placeholder relations and this node's params.
    guardFragments: (params) => [
      {
        context: "template",
        path: `steps.${step.id}`,
        sql: renderTemplate(step.template, { relation: placeholderFor, params, specs }),
        relations: ports.map(({ token }) => placeholderFor(token.space, token.name)),
      },
    ],
    // What runs: the same rendering, with the real relations.
    sql: (ctx) => ({
      output: renderTemplate(step.template, {
        relation: (space, name) => ctx.inputs[portFor(space, name)],
        params: ctx.params,
        specs,
      }),
    }),
  });
}

/**
 * Build (and register the internal steps of) a generated transformer.
 * @param {any} spec   a spec that validate.js accepted
 * @param {{ level: 1|2|3 }} origin   the data level of the conversation that wrote it
 */
export function specToTransformer(spec, { level }) {
  for (const step of spec.steps) if (step.kind === "sql") registerInternal(templateStep(spec, step));
  const outputRef = (from, params) => {
    const ref = parseFrom(from);
    return { step: ref.step, port: ref.port || stepOutputs(spec, ref.step, params)[0] };
  };
  return defineTransformer({
    apiVersion: API_VERSION,
    id: spec.id,
    name: spec.name || spec.id,
    group: "Custom",
    summary: spec.summary,
    description: spec.description,
    whenToUse: ["reuse the processing the assistant generated", "apply the same steps to another input"],
    whenNotToUse: ["a built-in transformer does the job — use that instead"],
    keywords: ["generated", "custom", spec.name || spec.id],
    examples: [{ input: "its inputs", params: "its params", output: "its outputs" }],
    inputs: spec.inputs,
    outputs: spec.outputs.map(({ id, label, description }) => ({ id, label, description })),
    params: kitParams(spec),
    generated: { spec, level },
    sql: () => {
      throw new Error(`${spec.id} is compiled through its steps.`);
    },
    expand: (node) => {
      const nodes = [];
      const edges = [];
      const stepParams = new Map();
      for (const step of spec.steps) {
        if (step.kind === "sql") {
          nodes.push({ step: step.id, type: stepType(spec, step), params: structuredClone(node.params) });
          for (const { id, token } of templatePorts(step)) {
            const from =
              token.space === "inputs"
                ? { input: token.name }
                : { step: token.name, port: stepOutputs(spec, token.name, stepParams.get(token.name))[0] };
            edges.push({ from, to: step.id, toPort: id });
          }
        } else {
          const params = callParams(step, node.params);
          stepParams.set(step.id, params);
          nodes.push({ step: step.id, type: step.transformer, params });
          for (const wire of step.inputs) {
            const ref = parseFrom(wire.from);
            const from =
              "input" in ref
                ? ref
                : { step: ref.step, port: ref.port || stepOutputs(spec, ref.step, stepParams.get(ref.step))[0] };
            edges.push({ from, to: step.id, toPort: wire.port });
          }
        }
      }
      const outputs = Object.fromEntries(
        spec.outputs.map((o) => [o.id, outputRef(o.from, stepParams.get(parseFrom(o.from).step))]),
      );
      return { nodes, edges, outputs };
    },
  });
}
