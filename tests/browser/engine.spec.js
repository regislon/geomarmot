/*
 * Runaway queries (docs/decisions/0004): a watched read is cancelled; one that
 * ignores the cancel gets the engine restarted, and every source survives.
 */

import { test, expect } from "@playwright/test";
import { openHarness } from "../harness/target.js";
import { workbook } from "../fixtures/build.js";

let h;
test.beforeAll(async ({ browser }) => {
  h = await openHarness(browser);
});
test.afterAll(async () => h?.server.close());

test("a cancellable runaway read is stopped without restarting the engine", async () => {
  const result = await h.page.evaluate(async () => {
    const { duck } = window.__geomarmotInternals;
    const before = duck.engineRestarts();
    const t0 = performance.now();
    let message = "";
    try {
      await duck.query("WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t) SELECT count(*) FROM t", {
        timeoutMs: 500,
      });
    } catch (err) {
      message = err.message;
    }
    return {
      message,
      ms: performance.now() - t0,
      restarted: duck.engineRestarts() - before,
      after: (await duck.query("SELECT 42 AS x"))[0].x,
    };
  });
  expect(result.message).toContain("was stopped");
  expect(result.restarted).toBe(0);
  expect(result.ms).toBeLessThan(4000);
  expect(result.after).toBe(42);
});

test("a read that ignores the cancel restarts the engine; sources and snapshots survive and the graph recompiles", async () => {
  const csv = Array.from(Buffer.from("id,name\n1,a\n2,b\n"));
  const xlsx = Array.from(
    workbook({
      s: [
        ["k", "v"],
        ["x", 1],
        ["y", 2],
      ],
    }),
  );
  const result = await h.page.evaluate(
    async ({ csv, xlsx }) => {
      const { duck } = window.__geomarmotInternals;
      const api = window.__geomarmotHarness;
      const [csvSource] = await api.loadSourceFile("keep.csv", csv);
      const [sheet] = await api.loadSourceFile("keep.xlsx", xlsx);
      const before = duck.engineRestarts();
      let message = "";
      try {
        // A nested-loop join on a spatial predicate: this build does not check for cancellation in it.
        await duck.query(
          "SELECT count(*) FROM (SELECT ST_Point(random(), random()) g FROM range(40000)) a, " +
            "(SELECT ST_Point(random(), random()) g FROM range(40000)) b WHERE ST_DWithin(a.g, b.g, 0.00001)",
          { timeoutMs: 800 },
        );
      } catch (err) {
        message = err.message;
      }
      const read = async (sourceId) => {
        const ids = api.buildGraph([{ key: "r", type: "Reader", params: { sourceId } }], []);
        const compiled = await api.compile();
        return (await api.readPort(compiled.views[ids.r].output)).rows.length;
      };
      return {
        message,
        restarted: duck.engineRestarts() - before,
        csvRows: await read(csvSource.id),
        sheetRows: await read(sheet.id),
        spatial: (await duck.query("SELECT ST_AsText(ST_Point(1, 2)) AS p"))[0].p,
      };
    },
    { csv, xlsx },
  );
  expect(result.message).toContain("engine was restarted");
  expect(result.restarted).toBe(1);
  expect(result.csvRows).toBe(2);
  expect(result.sheetRows).toBe(2);
  expect(result.spatial).toBe("POINT (1 2)");
});
