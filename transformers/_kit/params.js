// @ts-check
/*
 * Parameter kinds: the public vocabulary a transformer declares its parameters in.
 *
 * Each kind says what an empty value is (for a fresh node), and how a value of
 * that kind reaches SQL — which is what the SQL guard and the escaping contract
 * test key on (docs/params.md):
 *
 *   none        never reaches SQL (UI-only, or read by JavaScript)
 *   literal     becomes a quoted or validated literal
 *   identifier  becomes a quoted identifier (a column name)
 *   expression  a SQL expression fragment written by a person or the assistant
 *   query       a whole SELECT written by a person or the assistant
 */

/** @typedef {"none"|"literal"|"identifier"|"expression"|"query"} SqlUse */

/**
 * @typedef {object} ParamKind
 * @property {SqlUse} sql
 * @property {() => any} empty  the value a fresh node starts with, when the param has no default
 */

/** @type {Record<string, ParamKind>} */
export const KINDS = {
  string: { sql: "literal", empty: () => undefined },
  number: { sql: "literal", empty: () => undefined },
  select: { sql: "literal", empty: () => undefined },
  source: { sql: "none", empty: () => undefined },
  column: { sql: "identifier", empty: () => undefined },
  columns: { sql: "identifier", empty: () => [] },
  // A value spec may be a constant, an attribute, a formula or SQL; the SQL form is an expression.
  valuespec: { sql: "expression", empty: () => undefined },
  conditions: { sql: "literal", empty: () => [] },
  renames: { sql: "identifier", empty: () => [] },
  creates: { sql: "expression", empty: () => [] },
  valuerows: { sql: "expression", empty: () => [] },
  actions: { sql: "expression", empty: () => [] },
  sorts: { sql: "identifier", empty: () => [] },
  aggregates: { sql: "identifier", empty: () => [] },
  values: { sql: "literal", empty: () => [] },
  rules: { sql: "literal", empty: () => [] },
  joinkeys: { sql: "identifier", empty: () => [] },
  choices: { sql: "none", empty: () => [] },
  sqltext: { sql: "query", empty: () => undefined },
  sqlcreate: { sql: "query", empty: () => undefined },
};

/**
 * @typedef {object} ParamSpec
 * @property {string} id
 * @property {string} label
 * @property {keyof typeof KINDS} kind
 * @property {string} [description]   at least 10 words; checked by check:docs
 * @property {any} [default]
 * @property {string} [placeholder]
 * @property {(Array<string|{value: string, description?: string}>)|((node: any, context?: any) => string[])} [options]
 * @property {string[]} [choices]
 * @property {"numeric"} [filter]
 * @property {(node: any) => boolean} [when]  show the field only when this holds
 * @property {string} [units]
 */

function make(kind) {
  /**
   * @param {string} id
   * @param {string} label
   * @param {Partial<ParamSpec>} [options]
   * @returns {ParamSpec}
   */
  return (id, label, options = {}) => ({ id, label, kind, ...options });
}

/** Builders, one per kind: `param.column("x", "X attribute", { description })`. */
export const param = Object.fromEntries(Object.keys(KINDS).map((kind) => [kind, make(kind)]));

/** The value a fresh node starts with for each of its params. */
export function defaultParamValues(params) {
  const out = {};
  for (const spec of params) {
    if (spec.default !== undefined) out[spec.id] = structuredClone(spec.default);
    else {
      const empty = KINDS[spec.kind]?.empty();
      if (empty !== undefined) out[spec.id] = empty;
    }
  }
  return out;
}

/** The option values of a select param, whether written as strings or as {value, description}. */
export function optionValues(spec) {
  if (!Array.isArray(spec.options)) return [];
  return spec.options.map((option) => (typeof option === "string" ? option : option.value));
}
