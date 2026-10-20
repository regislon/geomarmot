// The GEOS overlay core, run in Node, gives the expected partition on every parity case.
import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import initGeosJs from "geos-wasm";
import { overlayParts } from "../../app/src/engines/geos/core.js";
import { compareToExpected, wktToWkb } from "../harness/geos-parity.js";

const PARITY = JSON.parse(readFileSync(new URL("../fixtures/geos-overlay-parity.json", import.meta.url), "utf8"));
const REPEATS = 20;

let geos;
beforeAll(async () => {
  geos = await initGeosJs();
});

describe("GEOS overlay core", () => {
  for (const [name, expected] of Object.entries(PARITY.cases)) {
    it(`matches the expected partition: ${name}`, () => {
      const parts = expected.parts.map((wkt) => wktToWkb(geos, wkt));
      const result = overlayParts(geos, parts, PARITY.tau);
      expect(compareToExpected(geos, result, expected)).toEqual([]);
    });
  }

  it("does not grow the WebAssembly heap over repeated overlays", () => {
    const parts = PARITY.cases.random.parts.map((wkt) => wktToWkb(geos, wkt));
    const sizes = [];
    for (let r = 0; r < REPEATS; r++) {
      overlayParts(geos, parts, PARITY.tau);
      sizes.push(geos.Module.HEAP8.length);
    }
    expect(sizes.at(-1)).toBe(sizes[REPEATS / 2]);
  });
});
