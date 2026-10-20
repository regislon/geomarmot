// @ts-check
/*
 * Proximity clusters of polygon parts, and the overlay tasks built from them.
 *
 * Each part's envelope, expanded by a margin, is stamped onto a coarse grid; parts sharing a cell are joined
 * (union-find). Two intersecting envelopes always share a cell, so a cluster can be coarser than the true
 * overlap groups but never splits one. The work is the number of cells stamped, which is budgeted: the cell
 * size doubles until the total fits.
 *
 * A part alone in its cluster is its own face, so it needs no overlay at all. The others are batched, whole
 * clusters at a time, into tasks of about `batchBytes` of WKB: overlaying disjoint clusters together gives
 * the same faces as overlaying them one by one, and saves the per-task cost of tiny clusters.
 */

const MAX_CELLS_PER_PART = 64;
const FALLBACK_CELL_FRACTION = 1e-3;
const CELL_KEY_STRIDE = 2 ** 26;
export const DEFAULT_BATCH_BYTES = 4 * 1024 ** 2;

/**
 * Cluster label for every part.
 *
 * @param {Float64Array} bounds  minx, miny, maxx, maxy per part, flattened
 * @param {number} margin
 * @returns {Int32Array}
 */
export function findClusters(bounds, margin) {
  const n = bounds.length / 4;
  const box = Float64Array.from(bounds, (v, i) => (i % 4 < 2 ? v - margin : v + margin));
  if (!n) return new Int32Array(0);
  let originX = Infinity;
  let originY = Infinity;
  for (let i = 0; i < n; i++) {
    originX = Math.min(originX, box[4 * i]);
    originY = Math.min(originY, box[4 * i + 1]);
  }
  let cell = initialCellSize(box, n);
  while (cellCount(box, n, cell, originX, originY) > MAX_CELLS_PER_PART * n) cell *= 2;
  return components(box, n, cell, originX, originY);
}

/** The median envelope side, or a fraction of the extent when every envelope is a point. */
function initialCellSize(box, n) {
  const spans = Array.from({ length: n }, (_, i) =>
    Math.max(box[4 * i + 2] - box[4 * i], box[4 * i + 3] - box[4 * i + 1]),
  ).sort((a, b) => a - b);
  const median = spans[n >> 1];
  if (median > 0) return median;
  let extent = 0;
  for (let i = 0; i < n; i++) extent = Math.max(extent, box[4 * i + 2], box[4 * i + 3]);
  return extent * FALLBACK_CELL_FRACTION || 1;
}

function cellRange(box, i, cell, originX, originY) {
  return [
    Math.floor((box[4 * i] - originX) / cell),
    Math.floor((box[4 * i + 1] - originY) / cell),
    Math.floor((box[4 * i + 2] - originX) / cell),
    Math.floor((box[4 * i + 3] - originY) / cell),
  ];
}

function cellCount(box, n, cell, originX, originY) {
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0, x1, y1] = cellRange(box, i, cell, originX, originY);
    total += (x1 - x0 + 1) * (y1 - y0 + 1);
  }
  return total;
}

/** Union-find over parts that share a cell; labels are numbered 0.. in order of first appearance. */
function components(box, n, cell, originX, originY) {
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const firstInCell = new Map();
  for (let i = 0; i < n; i++) {
    const [x0, y0, x1, y1] = cellRange(box, i, cell, originX, originY);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = x * CELL_KEY_STRIDE + y;
        const other = firstInCell.get(key);
        if (other === undefined) firstInCell.set(key, i);
        else parent[find(i)] = find(other);
      }
    }
  }
  const labels = new Int32Array(n);
  const numbering = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!numbering.has(root)) numbering.set(root, numbering.size);
    labels[i] = numbering.get(root);
  }
  return labels;
}

/**
 * Split parts into singletons (alone in their cluster) and overlay tasks of whole clusters.
 *
 * @param {Int32Array} labels  cluster per part
 * @param {Uint32Array | number[]} sizes  WKB bytes per part
 * @param {number} [batchBytes]
 * @returns {{ singletons: number[], tasks: number[][] }}  part indices
 */
export function buildTasks(labels, sizes, batchBytes = DEFAULT_BATCH_BYTES) {
  /** @type {number[][]} */
  const byCluster = [];
  labels.forEach((label, part) => (byCluster[label] ??= []).push(part));
  const singletons = [];
  const tasks = [];
  let current = [];
  let bytes = 0;
  for (const parts of byCluster) {
    if (parts.length === 1) {
      singletons.push(parts[0]);
      continue;
    }
    current.push(...parts);
    for (const p of parts) bytes += sizes[p];
    if (bytes >= batchBytes) {
      tasks.push(current);
      current = [];
      bytes = 0;
    }
  }
  if (current.length) tasks.push(current);
  return { singletons, tasks };
}
