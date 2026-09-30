// @ts-check
/*
 * The privacy gate: the only way data reaches a model provider.
 *
 * Every tool result, preview, error, repair message, ask_user answer and
 * conversation summary is passed through gate(type, payload, level) before it
 * is added to the provider conversation. The gate validates the payload
 * against that level's schema (schemas.js) and throws a GateError on anything
 * it does not allow; it never removes a field to make a payload fit. The
 * builders below produce payloads in the right shape for a level: they cut
 * text to the limits and choose structured or raw errors.
 *
 * What the user sees in the chat is not gated — the chat shows the full,
 * local-only version next to what was sent (docs/security.md).
 */

import { validate } from "../../core/jsonschema.js";
import { classify } from "./classify.js";
import { LIMITS, schemaFor } from "./schemas.js";

export { LIMITS, PAYLOAD_TYPES } from "./schemas.js";
export { classify } from "./classify.js";
export { structured, ERROR_CODES } from "./errors.js";
export { recordAiParams, redactParams } from "./origin.js";

export class GateError extends Error {
  constructor(type, level, errors) {
    super(
      `The privacy gate refused a ${type} payload at level ${level}: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}`,
    );
    this.name = "GateError";
    this.errors = errors;
  }
}

/**
 * Let a payload through, or throw.
 * @param {string} type    one of PAYLOAD_TYPES
 * @param {any} payload
 * @param {1|2|3} level
 */
export function gate(type, payload, level) {
  if (![1, 2, 3].includes(level)) throw new Error(`Unknown data level ${level}.`);
  const errors = validate(payload, schemaFor(type, level));
  if (errors.length) throw new GateError(type, level, errors);
  return payload;
}

/** Cut text to a length, marking that it was cut. */
export function cut(text, chars) {
  const value = String(text ?? "");
  return value.length <= chars ? value : `${value.slice(0, chars - 1)}…`;
}

/** A cell as it may be shown: numbers and booleans as they are, everything else as cut text. */
export function cell(value, chars = LIMITS.cellChars) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return cut(value.toString(), chars);
  if (value instanceof Date) return value.toISOString();
  return cut(typeof value === "object" ? JSON.stringify(value) : value, chars);
}

/** An error as it may be sent at a level: structured, plus the cut raw text at level 3. */
export function errorPayload(error, level) {
  const out = classify(error);
  if (level >= 3) {
    const raw = typeof error === "string" ? error : error?.message;
    if (raw) return { ...out, raw: cut(raw, LIMITS.errorChars) };
  }
  return out;
}

/** Sample rows as they may be sent at level 3: at most 20 rows, each cell cut. */
export function sampleRows(columns, rows) {
  return {
    columns: columns.map((c) => c.name ?? c),
    rows: rows.slice(0, LIMITS.rows).map((row) => columns.map((c) => cell(row[c.name ?? c]))),
  };
}
