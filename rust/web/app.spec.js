// Spike gate 5, browser: the egui app over DuckDB-Wasm, driven through its test hooks —
// open a file, chain Bufferer → Dissolver, read the table, export a download — then frame times
// on the page's main thread while the engine works, and cancel.
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

const fixture = readFileSync(new URL("../crates/app/tests/areas.geojson", import.meta.url));

const waitFor = (page, check, timeout = 60_000) => page.waitForFunction(check, null, { timeout, polling: 100 });

test("open, chain, read, export", async ({ page }) => {
  await page.goto("/app.html");
  await waitFor(page, () => window.__app);
  await page.evaluate((bytes) => window.__app.open("areas.geojson", new Uint8Array(bytes)), [...fixture]);
  await waitFor(page, () => window.__app.state().nodes === 1 && window.__app.state().status === "Ready.");
  await page.evaluate(() => {
    window.__app.command({ add: "Bufferer", params: { distance: "200" }, from: [0, 0] });
    window.__app.command({ add: "Dissolver", params: { groupBy: [] }, from: [1, 0] });
    window.__app.command({ select: [2, 0] });
  });
  await waitFor(page, () => (window.__app.state().rows ?? 0) > 0);
  expect(await page.evaluate(() => window.__app.state().status)).toBe("Ready.");
  const download = page.waitForEvent("download");
  await page.evaluate(() => window.__app.command({ export: true }));
  expect((await download).suggestedFilename()).toBe("export.parquet");
  await waitFor(page, () => window.__app.state().status.startsWith("Exported"));
});

test("frame times while the engine works, then cancel", async ({ page }) => {
  await page.goto("/app.html");
  await waitFor(page, () => window.__app);
  const stats = await page.evaluate(async () => {
    const work = globalThis.gmBridge.exec("SELECT sum(hash(i)) FROM range(400000000000) t(i)").catch((e) => e.message);
    const frames = [];
    let last = performance.now();
    await new Promise((done) => {
      const end = last + 10_000;
      const tick = (now) => {
        frames.push(now - last);
        last = now;
        if (now < end) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    const t0 = performance.now();
    const cancelled = await globalThis.gmBridge.cancel();
    const stopMs = Math.round(performance.now() - t0);
    await work;
    frames.sort((a, b) => a - b);
    const pct = (p) => +frames[Math.min(frames.length - 1, Math.floor(frames.length * p))].toFixed(1);
    return {
      frames: frames.length,
      p50: pct(0.5),
      p95: pct(0.95),
      p99: pct(0.99),
      longest: +frames.at(-1).toFixed(1),
      cancelled,
      stopMs,
    };
  });
  console.log("browser frames with the engine busy:", JSON.stringify(stats));
  expect(stats.p95).toBeLessThanOrEqual(33);
  expect(stats.p99).toBeLessThanOrEqual(50);
  expect(stats.longest).toBeLessThanOrEqual(100);
});
