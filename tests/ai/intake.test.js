import { test, expect } from "vitest";
import { intakeProposal } from "../../app/src/ai/intake.js";
import { ERROR_CATALOGUE } from "../../app/src/ai/gate/errors.js";

const graph = { nodes: [], edges: [] };
const propose = (params) =>
  intakeProposal(
    { nodes: [{ ref: "pts", type: "VertexCreator", params_json: JSON.stringify(params) }], edges: [] },
    { graph, levelReached: 1 },
  );

test("a refused param says what is wrong, so the model can fix it", async () => {
  const bare = await propose({ mode: "Replace with Point", x: "Longitude", y: "Latitude" });
  expect(bare.ok).toBe(false);
  const error = bare.problems[0].error;
  expect(error).toMatchObject({
    code: "INVALID_PARAMS",
    params: { param: "x", transformer: "VertexCreator", problem: "x must be object; y must be object" },
  });
  expect(error.message).toBe(ERROR_CATALOGUE.INVALID_PARAMS.message(error.params));

  const wrongOption = await propose({ mode: "replace", x: { kind: "attribute", column: "Longitude" } });
  expect(wrongOption.problems[0].error.params.problem).toMatch(/mode must be one of Add Point, Replace with Point/);
  expect(wrongOption.problems[0].error.params.problem).toMatch(/x\.kind must be one of Value, Attribute/);
});

test("the problem never echoes a value that was sent", async () => {
  const result = await propose({ mode: "CANARY-not-an-option", x: { kind: "CANARY-kind" } });
  expect(JSON.stringify(result)).not.toContain("CANARY");
});

test("the right shape is accepted", async () => {
  const ok = await propose({
    mode: "Replace with Point",
    x: { kind: "Attribute", column: "Longitude" },
    y: { kind: "Attribute", column: "Latitude" },
  });
  expect(ok.ok).toBe(true);
});
