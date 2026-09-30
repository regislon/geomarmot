import { describe, expect, it } from "vitest";
import { compareGeometry, compareTable } from "./compare.js";

const square = "POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))";

describe("compareGeometry — exact", () => {
  it("accepts identical geometry and tiny float noise", () => {
    expect(compareGeometry(square, square)).toBeNull();
    expect(compareGeometry("POINT (1 2)", "POINT (1.0000000000001 2)")).toBeNull();
  });

  it("rejects the same square shifted by one tolerance step", () => {
    expect(compareGeometry("POINT (1 2)", "POINT (1.000000002 2)")).not.toBeNull();
    expect(compareGeometry(square, "POLYGON ((0 0, 1.000001 0, 1 1, 0 1, 0 0))", { tolerance: 1e-9 })).not.toBeNull();
  });

  it("rejects a different start vertex unless ringStart is ignored", () => {
    const rotated = "POLYGON ((1 0, 1 1, 0 1, 0 0, 1 0))";
    expect(compareGeometry(rotated, square)).not.toBeNull();
    expect(compareGeometry(rotated, square, { ignore: ["ringStart"] })).toBeNull();
  });

  it("rejects reversed orientation unless orientation is ignored", () => {
    const reversed = "POLYGON ((0 0, 0 1, 1 1, 1 0, 0 0))";
    expect(compareGeometry(reversed, square)).not.toBeNull();
    expect(compareGeometry(reversed, square, { ignore: ["orientation"] })).toBeNull();
    expect(compareGeometry("LINESTRING (1 1, 0 0)", "LINESTRING (0 0, 1 1)")).not.toBeNull();
  });

  it("rejects a different part order unless partOrder is ignored", () => {
    const ab = "MULTIPOINT ((0 0), (1 1))";
    const ba = "MULTIPOINT ((1 1), (0 0))";
    expect(compareGeometry(ab, ba)).not.toBeNull();
    expect(compareGeometry(ab, ba, { ignore: ["partOrder"] })).toBeNull();
  });

  it("checks Z and dimensions", () => {
    expect(compareGeometry("POINT Z (1 2 3)", "POINT Z (1 2 3)")).toBeNull();
    expect(compareGeometry("POINT Z (1 2 3)", "POINT Z (1 2 4)")).not.toBeNull();
    expect(compareGeometry("POINT Z (1 2 3)", "POINT (1 2)")).not.toBeNull();
  });

  it("compares empties and nulls as themselves", () => {
    expect(compareGeometry("POINT EMPTY", "POINT EMPTY")).toBeNull();
    expect(compareGeometry("POINT EMPTY", "POINT (0 0)")).not.toBeNull();
    expect(compareGeometry(null, null)).toBeNull();
    expect(compareGeometry(null, "POINT (0 0)")).not.toBeNull();
  });
});

describe("compareGeometry — topology", () => {
  const topo = { mode: "topology", tolerance: 1e-6, areaTolerance: 1e-6 };

  it("accepts the same shape with different vertices", () => {
    const densified = "POLYGON ((0 0, 0.5 0, 1 0, 1 1, 0 1, 0 0))";
    expect(compareGeometry(densified, square, topo)).toBeNull();
  });

  it("rejects two different polygons with equal area and equal bounds", () => {
    // Both fill half of the unit square, both have bounds (0,0)-(1,1).
    const lower = "POLYGON ((0 0, 1 0, 0 1, 0 0))";
    const upper = "POLYGON ((1 0, 1 1, 0 1, 1 0))";
    expect(compareGeometry(lower, upper, topo)).not.toBeNull();
  });

  it("rejects a shifted shape", () => {
    expect(
      compareGeometry(
        "POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))",
        "POLYGON ((0.001 0, 1.001 0, 1.001 1, 0.001 1, 0.001 0))",
        topo,
      ),
    ).not.toBeNull();
  });
});

describe("compareTable", () => {
  const columns = [
    { name: "id", type: "VARCHAR" },
    { name: "geometry", type: "GEOMETRY" },
  ];

  it("matches rows as a multiset", () => {
    const actual = {
      columns,
      rows: [
        ["b", "POINT (1 1)"],
        ["a", "POINT (0 0)"],
      ],
    };
    const expected = {
      columns,
      rows: [
        ["a", "POINT (0 0)"],
        ["b", "POINT (1 1)"],
      ],
    };
    expect(compareTable(actual, expected)).toEqual([]);
    expect(compareTable(actual, expected, { ordered: true }).length).toBeGreaterThan(0);
  });

  it("reports column differences", () => {
    const actual = { columns: [{ name: "id", type: "INTEGER" }], rows: [] };
    expect(compareTable(actual, { columns: [{ name: "id", type: "VARCHAR" }], rows: [] })[0]).toMatch(/columns differ/);
  });

  it("reports missing and unexpected rows", () => {
    const problems = compareTable({ columns, rows: [["c", null]] }, { columns, rows: [["a", null]] });
    expect(problems.join("\n")).toMatch(/missing row/);
    expect(problems.join("\n")).toMatch(/unexpected row/);
  });
});
