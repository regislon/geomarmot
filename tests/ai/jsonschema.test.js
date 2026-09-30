import { describe, test, expect } from "vitest";
import { assertValid, validate } from "../../app/src/core/jsonschema.js";

describe("jsonschema", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["n"],
    properties: {
      n: { type: "integer", minimum: 0, maximum: 5 },
      s: { type: "string", maxLength: 3, pattern: "^[a-z]+$" },
      list: { type: "array", maxItems: 2, uniqueItems: true, items: { $ref: "#/$defs/item" } },
      either: { anyOf: [{ type: "number" }, { const: "x" }] },
    },
    $defs: { item: { enum: ["a", "b", "c"] } },
  };

  test("accepts a valid value", () => {
    expect(validate({ n: 2, s: "ab", list: ["a", "b"], either: "x" }, schema)).toEqual([]);
  });

  test.each([
    [{}, "missing n"],
    [{ n: 1.5 }, "integer"],
    [{ n: 9 }, "above"],
    [{ n: 1, s: "abcd" }, "longer"],
    [{ n: 1, s: "AB" }, "match"],
    [{ n: 1, list: ["a", "a"] }, "repeated"],
    [{ n: 1, list: ["z"] }, "one of"],
    [{ n: 1, extra: true }, "not allowed"],
    [{ n: 1, either: "y" }, "none of"],
  ])("refuses %j (%s)", (value, message) => {
    expect(
      validate(value, schema)
        .map((e) => e.message)
        .join(" "),
    ).toContain(message);
  });

  test("an unknown keyword is an error, not a silent pass", () => {
    expect(() => validate(1, { type: "number", multipleOf: 2 })).toThrow(/Unsupported/);
  });

  test("assertValid lists every problem", () => {
    expect(() => assertValid({ n: -1, extra: 1 }, schema, "thing")).toThrow(/thing is not valid: .*below.*not allowed/);
  });
});
