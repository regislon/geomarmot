//! Proximity clusters of polygon parts, and the overlay tasks built from them.
//! Port of `app/src/engines/geos/cluster.js`.
//!
//! Each part's envelope, expanded by a margin, is stamped onto a coarse grid; parts
//! sharing a cell are joined (union-find). Two intersecting envelopes always share a
//! cell, so a cluster can be coarser than the true overlap groups but never splits one.
//! A part alone in its cluster is its own face; the others are batched, whole clusters
//! at a time, into tasks of about `batch_bytes` of WKB.

use std::collections::HashMap;

const MAX_CELLS_PER_PART: f64 = 64.0;
const FALLBACK_CELL_FRACTION: f64 = 1e-3;
pub const DEFAULT_BATCH_BYTES: usize = 4 * 1024 * 1024;

type Bounds = [f64; 4];

fn cell_range(b: &Bounds, cell: f64, ox: f64, oy: f64) -> [i64; 4] {
    [
        ((b[0] - ox) / cell).floor() as i64,
        ((b[1] - oy) / cell).floor() as i64,
        ((b[2] - ox) / cell).floor() as i64,
        ((b[3] - oy) / cell).floor() as i64,
    ]
}

/// Cluster label for every part.
pub fn find_clusters(bounds: &[Bounds], margin: f64) -> Vec<usize> {
    let n = bounds.len();
    if n == 0 {
        return vec![];
    }
    let boxes: Vec<Bounds> = bounds
        .iter()
        .map(|b| [b[0] - margin, b[1] - margin, b[2] + margin, b[3] + margin])
        .collect();
    let ox = boxes.iter().map(|b| b[0]).fold(f64::INFINITY, f64::min);
    let oy = boxes.iter().map(|b| b[1]).fold(f64::INFINITY, f64::min);
    let mut spans: Vec<f64> = boxes.iter().map(|b| (b[2] - b[0]).max(b[3] - b[1])).collect();
    spans.sort_by(f64::total_cmp);
    let mut cell = spans[n >> 1];
    if cell <= 0.0 {
        let extent = boxes.iter().map(|b| b[2].max(b[3])).fold(0.0, f64::max);
        cell = Some(extent * FALLBACK_CELL_FRACTION)
            .filter(|c| *c != 0.0)
            .unwrap_or(1.0);
    }
    let count = |cell: f64| -> f64 {
        boxes
            .iter()
            .map(|b| {
                let [x0, y0, x1, y1] = cell_range(b, cell, ox, oy);
                ((x1 - x0 + 1) * (y1 - y0 + 1)) as f64
            })
            .sum()
    };
    while count(cell) > MAX_CELLS_PER_PART * n as f64 {
        cell *= 2.0;
    }
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    let mut first_in_cell: HashMap<(i64, i64), usize> = HashMap::new();
    for (i, b) in boxes.iter().enumerate() {
        let [x0, y0, x1, y1] = cell_range(b, cell, ox, oy);
        for x in x0..=x1 {
            for y in y0..=y1 {
                match first_in_cell.get(&(x, y)) {
                    None => {
                        first_in_cell.insert((x, y), i);
                    }
                    Some(&other) => {
                        let (a, b) = (find(&mut parent, i), find(&mut parent, other));
                        parent[a] = b;
                    }
                }
            }
        }
    }
    let mut numbering = HashMap::new();
    (0..n)
        .map(|i| {
            let root = find(&mut parent, i);
            let next = numbering.len();
            *numbering.entry(root).or_insert(next)
        })
        .collect()
}

/// Split parts into singletons (alone in their cluster) and tasks of whole clusters.
pub fn build_tasks(labels: &[usize], sizes: &[usize], batch_bytes: usize) -> (Vec<usize>, Vec<Vec<usize>>) {
    let clusters = labels.iter().copied().max().map_or(0, |m| m + 1);
    let mut by_cluster: Vec<Vec<usize>> = vec![vec![]; clusters];
    for (part, &label) in labels.iter().enumerate() {
        by_cluster[label].push(part);
    }
    let (mut singletons, mut tasks, mut current, mut bytes) = (vec![], vec![], vec![], 0);
    for parts in by_cluster {
        if parts.len() == 1 {
            singletons.push(parts[0]);
            continue;
        }
        bytes += parts.iter().map(|&p| sizes[p]).sum::<usize>();
        current.extend(parts);
        if bytes >= batch_bytes {
            tasks.push(std::mem::take(&mut current));
            bytes = 0;
        }
    }
    if !current.is_empty() {
        tasks.push(current);
    }
    (singletons, tasks)
}
