import { test, expect } from "vitest";
import { load, serialize } from "../../app/src/core/graph/model.js";
import { hashValue } from "../../app/src/ai/gate/origin.js";

const good = { by: "ai", level: 3, hash: hashValue("x") };

test("paramOrigin survives saving and opening a graph; malformed entries are dropped", () => {
  load({
    format: "geomarmot-graph",
    version: 1,
    nodes: [
      {
        id: "n1",
        type: "Tester",
        x: 0,
        y: 0,
        params: { logic: "AND", conditions: [{ column: "a", operator: "=", value: "x" }] },
        paramOrigin: {
          "conditions[0].value": good,
          logic: { by: "user" },
          bad: { by: "ai", level: 9, hash: "zz" },
        },
      },
      { id: "n2", type: "Tester", x: 0, y: 0, params: {}, paramOrigin: { a: { by: "user" } } },
    ],
    edges: [],
  });
  const saved = serialize();
  expect(saved.nodes[0].paramOrigin).toEqual({ "conditions[0].value": good });
  expect(saved.nodes[1].paramOrigin).toBeUndefined();
  // A copy, not the live object.
  saved.nodes[0].paramOrigin["conditions[0].value"].level = 1;
  expect(serialize().nodes[0].paramOrigin["conditions[0].value"].level).toBe(3);
});
