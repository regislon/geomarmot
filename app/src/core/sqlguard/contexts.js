// @ts-check
/*
 * Validation contexts for untrusted SQL fragments (docs/security.md, D7).
 *
 * A fragment is never validated on its own and then spliced somewhere else: each
 * context builds a placeholder form of the statement with the same pure function
 * a transformer splices with, so the only difference between what was checked
 * and what runs is the trusted relation name.
 */

import { composeSql } from "../sqlnode.js";

/** Placeholder for the upstream relation in a placeholder form. */
export const INPUT_PLACEHOLDER = "__gm_input";

/**
 * Splice an expression fragment the one way transformers are allowed to.
 * The newlines stop a trailing `--` comment in the fragment from swallowing the
 * closing parenthesis.
 * @param {string} fragment
 */
export function spliceExpression(fragment) {
  return `(\n${fragment}\n)`;
}

/**
 * Splice a query fragment over an upstream relation (binds it as `input`).
 * @param {string} fragment
 * @param {string} relation
 */
export function spliceQuery(fragment, relation) {
  return composeSql(fragment, relation);
}

/**
 * @typedef {object} Context
 * @property {(fragment: string, opts?: any) => string} placeholder
 * @property {(opts?: any) => Set<string>} relations  base relations the statement may read
 */

/** @type {Record<"query"|"expression"|"template", Context>} */
export const CONTEXTS = {
  query: {
    placeholder: (fragment) => spliceQuery(fragment, INPUT_PLACEHOLDER),
    relations: () => new Set([INPUT_PLACEHOLDER, "input"]),
  },
  expression: {
    placeholder: (fragment) => `SELECT ${spliceExpression(fragment)} AS v FROM ${INPUT_PLACEHOLDER} AS input`,
    relations: () => new Set([INPUT_PLACEHOLDER, "input"]),
  },
  template: {
    // Templates arrive already rendered, with {{…}} replaced by placeholder relation names.
    placeholder: (fragment) => fragment,
    relations: (opts = {}) => new Set(opts.relations || []),
  },
};
