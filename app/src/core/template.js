// @ts-check
/*
 * Typed SQL templates, for generated transformers (Mode B).
 *
 * A template is a SELECT with three kinds of placeholder, and nothing else in
 * double braces:
 *
 *   {{inputs.<port>}}   a relation: one of the transformer's inputs
 *   {{steps.<id>}}      a relation: an earlier step's output
 *   {{params.<id>}}     a value, rendered by the param's kind:
 *                         column  → a quoted identifier
 *                         columns → a comma-separated list of quoted identifiers
 *                         number  → a finite numeric literal
 *                         string, select → a quoted string literal
 *
 * There is no raw splicing. The same function renders the template twice: once
 * with placeholder relation names (__gm_in_<port>, __gm_step_<id>), which is
 * what the SQL guard validates in its "template" context, and once with the
 * real relation names, which is what runs — so the two differ only in those
 * names (docs/security.md).
 */

import { qid, qlit } from "./duck.js";

const TOKEN = /\{\{\s*([a-z]+)\.([A-Za-z0-9_]+)\s*\}\}/g;
export const TEMPLATE_KINDS = ["string", "number", "select", "column", "columns"];

export class TemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = "TemplateError";
    this.code = "SQL_FORBIDDEN_CONSTRUCT";
  }
}

/** Every placeholder in a template, in order. Throws on anything in braces that is not one. */
export function tokens(template) {
  const found = [];
  const text = String(template);
  const stripped = text.replace(TOKEN, (_, space, name) => {
    if (!["inputs", "steps", "params"].includes(space))
      throw new TemplateError(`{{${space}.${name}}} is not a placeholder.`);
    found.push({ space, name });
    return "";
  });
  if (/\{\{|\}\}/.test(stripped))
    throw new TemplateError("Only {{inputs.…}}, {{steps.…}} and {{params.…}} may appear in braces.");
  return found;
}

/** The placeholder relation name for an input or a step. */
export const placeholderFor = (space, name) => (space === "inputs" ? `__gm_in_${name}` : `__gm_step_${name}`);

/** A param value as SQL, by kind. */
export function renderParam(spec, value) {
  switch (spec.kind) {
    case "column":
      if (typeof value !== "string" || !value) throw new TemplateError(`Param ${spec.id} needs a column.`);
      return qid(value);
    case "columns": {
      const list = Array.isArray(value) ? value.filter((v) => typeof v === "string" && v) : [];
      if (!list.length) throw new TemplateError(`Param ${spec.id} needs at least one column.`);
      return list.map(qid).join(", ");
    }
    case "number": {
      const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
      if (value === "" || value === null || value === undefined || !Number.isFinite(number))
        throw new TemplateError(`Param ${spec.id} needs a finite number.`);
      return String(number);
    }
    case "string":
    case "select":
      return qlit(String(value ?? ""));
    default:
      throw new TemplateError(`Params of kind ${spec.kind} cannot be used in a template.`);
  }
}

/**
 * Render a template.
 * @param {string} template
 * @param {{ relation: (space: "inputs"|"steps", name: string) => string, params: Record<string, any>, specs: Array<{ id: string, kind: string }> }} env
 */
export function renderTemplate(template, { relation, params, specs }) {
  tokens(template); // refuses stray braces before anything is rendered
  return String(template).replace(TOKEN, (_, space, name) => {
    if (space === "params") {
      const spec = specs.find((p) => p.id === name);
      if (!spec) throw new TemplateError(`{{params.${name}}} is not a param of this transformer.`);
      return renderParam(spec, params?.[name]);
    }
    return relation(space, name);
  });
}
