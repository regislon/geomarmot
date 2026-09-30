import { test, expect } from "vitest";
import pure from "../../examples/pure-sql/index.js";
import prepared from "../../examples/sql-with-prepare/index.js";
import crsHook from "../../examples/crs-hook/index.js";

test("the reference examples are valid transformers of each pattern", () => {
  expect(pure.sql && !pure.prepare).toBeTruthy();
  expect(prepared.prepare && prepared.sql).toBeTruthy();
  expect(crsHook.crs && crsHook.check).toBeTruthy();
});
