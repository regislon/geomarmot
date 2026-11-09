//! The overlay kernel: every polygon part at once, into faces with the features covering
//! them. Port of `app/src/engines/geos/index.js`, with tasks run in parallel (rayon)
//! instead of a pool of WebAssembly workers.

mod cluster;
pub mod geo_core;
mod geos_core;
mod wkb;

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};

use rayon::prelude::*;

pub use cluster::{DEFAULT_BATCH_BYTES, build_tasks, find_clusters};
pub use geos_core::{TaskResult, overlay_parts};

const TAU_FRACTION: f64 = 1e-9;

/// Polygon parts: the feature each belongs to, its WKB and envelope.
#[derive(Default)]
pub struct Parts {
    pub fid: Vec<i64>,
    pub wkb: Vec<Vec<u8>>,
    pub bounds: Vec<[f64; 4]>,
}

pub struct Face {
    pub wkb: Vec<u8>,
    pub bounds: [f64; 4],
    pub fids: Vec<i64>,
}

pub struct AmbiguousFace {
    pub wkb: Vec<u8>,
    pub area: f64,
    pub clearance: f64,
}

#[derive(Default)]
pub struct Faces {
    /// In the fixed numbering order (by envelope, then covering features).
    pub kept: Vec<Face>,
    pub ambiguous: Vec<AmbiguousFace>,
    pub tasks: usize,
}

/// Clearance tolerance: a tiny fraction of the data extent (floating-noise scale).
pub fn default_tau(bounds: &[[f64; 4]]) -> f64 {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for b in bounds {
        (x0, y0, x1, y1) = (x0.min(b[0]), y0.min(b[1]), x1.max(b[2]), y1.max(b[3]));
    }
    (x1 - x0).max(y1 - y0).max(1.0) * TAU_FRACTION
}

/// Which overlay core computes the faces.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Kernel {
    /// Noding and polygonizing on native GEOS (the reference).
    #[default]
    Geos,
    /// Incremental splitting on `geo`, pure Rust.
    Geo,
}

/// Overlay every part. `cancel` is checked between tasks.
pub fn overlay_faces(parts: &Parts, kernel: Kernel, cancel: &AtomicBool) -> Result<Faces, String> {
    if parts.wkb.is_empty() {
        return Ok(Faces::default());
    }
    let tau = default_tau(&parts.bounds);
    let labels = find_clusters(&parts.bounds, tau);
    let sizes: Vec<usize> = parts.wkb.iter().map(Vec::len).collect();
    let (singletons, tasks) = build_tasks(&labels, &sizes, DEFAULT_BATCH_BYTES);
    let results: Vec<TaskResult> = tasks
        .par_iter()
        .map(|task| {
            if cancel.load(Ordering::Relaxed) {
                return Err("The overlay was cancelled.".to_string());
            }
            let wkb: Vec<&[u8]> = task.iter().map(|&i| parts.wkb[i].as_slice()).collect();
            match kernel {
                Kernel::Geos => overlay_parts(&wkb, tau),
                Kernel::Geo => geo_core::overlay_parts(&wkb, tau),
            }
        })
        .collect::<Result<_, _>>()?;

    let mut out = Faces {
        tasks: tasks.len(),
        ..Faces::default()
    };
    for &i in &singletons {
        out.kept.push(Face {
            wkb: parts.wkb[i].clone(),
            bounds: parts.bounds[i],
            fids: vec![parts.fid[i]],
        });
    }
    for (t, r) in results.into_iter().enumerate() {
        for (f, wkb) in r.faces.into_iter().enumerate() {
            if r.ambiguous[f] {
                out.ambiguous.push(AmbiguousFace {
                    wkb,
                    area: r.areas[f],
                    clearance: r.clearance[f],
                });
                continue;
            }
            let fids: BTreeSet<i64> = r.members[f].iter().map(|&m| parts.fid[tasks[t][m]]).collect();
            if !fids.is_empty() {
                out.kept.push(Face {
                    wkb,
                    bounds: r.bounds[f],
                    fids: fids.into_iter().collect(),
                });
            }
        }
    }
    out.kept.sort_by(|a, b| {
        a.bounds
            .iter()
            .zip(&b.bounds)
            .map(|(x, y)| x.total_cmp(y))
            .find(|o| o.is_ne())
            .unwrap_or(a.fids.cmp(&b.fids))
    });
    Ok(out)
}
