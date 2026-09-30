// @ts-check
/*
 * A small JSON Schema validator, for the subset GeoMarmot's own schemas use.
 *
 * The privacy gate and the assistant's intake both refuse anything a schema
 * does not allow, so they need a validator in the browser. This one covers
 * type, enum, const, properties, required, additionalProperties (false or a
 * schema), items, min/maxItems, uniqueItems, min/maxLength, pattern,
 * minimum/maximum, anyOf, oneOf and local $ref ("#/$defs/…"). A keyword it does
 * not know is an error, not a silent pass: a schema that relied on it would
 * otherwise validate everything.
 */

const KNOWN = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "anyOf",
  "oneOf",
]);

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

const matchesType = (value, type) => {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
};

function resolve(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`Only local $ref is supported, not ${ref}`);
  let node = root;
  for (const part of ref.slice(2).split("/")) node = node?.[part];
  if (!node) throw new Error(`Unresolved $ref ${ref}`);
  return node;
}

/**
 * Validate a value; returns a list of problems, empty when it is valid.
 * @param {any} value
 * @param {object} schema
 * @param {object} [root]  the document local $refs resolve against (defaults to schema)
 * @returns {Array<{path: string, message: string}>}
 */
export function validate(value, schema, root = schema) {
  const errors = [];
  walk(value, schema, root, "$", errors);
  return errors;
}

function walk(value, schema, root, path, errors) {
  if (schema === true || schema === undefined) return;
  if (schema === false) return void errors.push({ path, message: "is not allowed" });
  for (const key of Object.keys(schema)) if (!KNOWN.has(key)) throw new Error(`Unsupported schema keyword ${key}`);
  const fail = (message) => errors.push({ path, message });

  if (schema.$ref) walk(value, resolve(root, schema.$ref), root, path, errors);
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((type) => matchesType(value, type))) return void fail(`must be ${types.join(" or ")}`);
  }
  if (schema.enum && !schema.enum.some((option) => option === value)) fail(`must be one of ${schema.enum.join(", ")}`);
  if ("const" in schema && schema.const !== value) fail(`must be ${JSON.stringify(schema.const)}`);
  if (schema.anyOf && !schema.anyOf.some((option) => !validate(value, option, root).length))
    fail("matches none of the allowed forms");
  if (schema.oneOf && schema.oneOf.filter((option) => !validate(value, option, root).length).length !== 1)
    fail("must match exactly one of the allowed forms");

  if (typeof value === "string") {
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      fail(`is longer than ${schema.maxLength} characters`);
    if (schema.minLength !== undefined && value.length < schema.minLength)
      fail(`is shorter than ${schema.minLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) fail(`does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`is below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`is above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`has more than ${schema.maxItems} items`);
    if (schema.minItems !== undefined && value.length < schema.minItems)
      fail(`has fewer than ${schema.minItems} items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length)
      fail("has repeated items");
    if (schema.items) value.forEach((item, index) => walk(item, schema.items, root, `${path}[${index}]`, errors));
  }
  if (typeOf(value) === "object") {
    const properties = schema.properties || {};
    for (const key of schema.required || []) if (!(key in value)) fail(`is missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (key in properties) walk(item, properties[key], root, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false)
        errors.push({ path: `${path}.${key}`, message: "is not allowed" });
      else if (typeof schema.additionalProperties === "object")
        walk(item, schema.additionalProperties, root, `${path}.${key}`, errors);
    }
  }
}

/** Throw with every problem listed, for callers that only want valid input. */
export function assertValid(value, schema, what = "value") {
  const errors = validate(value, schema);
  if (errors.length) {
    const list = errors.map((e) => `${e.path} ${e.message}`).join("; ");
    throw Object.assign(new Error(`${what} is not valid: ${list}`), { errors });
  }
  return value;
}
