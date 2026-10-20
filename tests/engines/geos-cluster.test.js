// Proximity clusters and overlay tasks for the GEOS overlay engine.
import { describe, expect, it } from "vitest";
import { buildTasks, findClusters } from "../../app/src/engines/geos/cluster.js";
import { defaultTau } from "../../app/src/engines/geos/index.js";

const boxes = (list) => Float64Array.from(list.flat());

describe("findClusters", () => {
  it("joins overlapping and touching parts, and keeps distant ones apart", () => {
    const labels = findClusters(
      boxes([
        [0, 0, 2, 2],
        [1, 1, 3, 3], // overlaps the first
        [3, 0, 4, 1], // touches the second
        [10, 10, 11, 11],
        [20, 20, 21, 21],
      ]),
      1e-9,
    );
    expect(labels[0]).toBe(labels[1]);
    expect(labels[1]).toBe(labels[2]);
    expect(new Set(labels).size).toBe(3);
  });

  it("never splits a chain of overlaps, even when envelopes are much larger than the median", () => {
    const chain = Array.from({ length: 50 }, (_, i) => [i, 0, i + 1.5, 1]);
    const labels = findClusters(boxes([...chain, [0, -100, 100, -99]]), 1e-9);
    expect(new Set(labels.slice(0, 50)).size).toBe(1);
  });

  it("handles point-like envelopes and an empty input", () => {
    expect(
      Array.from(
        findClusters(
          boxes([
            [1, 1, 1, 1],
            [1, 1, 1, 1],
            [5, 5, 5, 5],
          ]),
          0,
        ),
      ),
    ).toEqual([0, 0, 1]);
    expect(findClusters(new Float64Array(0), 1e-9).length).toBe(0);
  });
});

describe("buildTasks", () => {
  it("leaves lone parts out of every task and keeps clusters whole", () => {
    const labels = Int32Array.from([0, 0, 1, 2, 2, 2, 3]);
    const { singletons, tasks } = buildTasks(labels, [10, 10, 10, 10, 10, 10, 10], 25);
    expect(singletons).toEqual([2, 6]);
    expect(tasks).toEqual([[0, 1, 3, 4, 5]]);
  });

  it("cuts tasks at cluster boundaries once a batch is big enough", () => {
    const labels = Int32Array.from([0, 0, 1, 1, 2, 2]);
    const { tasks } = buildTasks(labels, [10, 10, 10, 10, 10, 10], 20);
    expect(tasks).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
  });
});

describe("defaultTau", () => {
  it("is a billionth of the extent, at least 1e-9", () => {
    expect(defaultTau(boxes([[0, 0, 1000, 10]]))).toBeCloseTo(1e-6, 15);
    expect(defaultTau(boxes([[0, 0, 0.1, 0.1]]))).toBe(1e-9);
  });
});
