//! The engine, driven off the UI thread: the engine process on the desktop (`native`),
//! DuckDB-Wasm in its worker in the browser (`web`). The UI sends jobs; replies come back
//! tagged with the generation they belong to, and the UI drops stale ones.

#[cfg(not(target_arch = "wasm32"))]
mod native;
#[cfg(not(target_arch = "wasm32"))]
pub use native::Worker;
#[cfg(target_arch = "wasm32")]
mod web;
#[cfg(target_arch = "wasm32")]
pub use web::Worker;

use std::path::PathBuf;

use geomarmot_core::graph::{Graph, NodeState};
use geomarmot_core::{SqlEngine, qid};
use serde_json::Value;

pub enum Job {
    Open(PathBuf),
    Compile(Graph),
    Read {
        view: String,
    },
    Export {
        view: String,
        to: PathBuf,
    },
    /// Run a statement for its effect (the probe's workload).
    Exec(String),
    /// The browser: a file the user picked, as bytes.
    OpenBytes {
        name: String,
        bytes: Vec<u8>,
    },
}

pub struct Table {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    /// GeoJSON geometry of each row, when there is a geometry column.
    pub shapes: Vec<Value>,
}

pub enum Reply {
    Opened {
        relation: String,
        label: String,
    },
    Compiled {
        generation: u64,
        states: std::collections::BTreeMap<usize, NodeState>,
    },
    Read {
        view: String,
        table: Result<Table, String>,
    },
    Status(String),
}

const PAGE: usize = 200;
const MAP_LIMIT: usize = 20_000;

async fn read(engine: &impl SqlEngine, view: &str) -> Result<Table, String> {
    let described = engine.describe(view).await?;
    let geometry = described
        .iter()
        .find(|c| c.kind.starts_with("GEOMETRY"))
        .map(|c| c.name.clone());
    let cells: Vec<String> = described
        .iter()
        .map(|c| {
            if c.kind.starts_with("GEOMETRY") {
                format!("ST_AsText({})::VARCHAR", qid(&c.name))
            } else {
                format!("{}::VARCHAR", qid(&c.name))
            }
        })
        .collect();
    let rows = engine
        .query(&format!("SELECT {} FROM {view} LIMIT {PAGE}", cells.join(", ")))
        .await?;
    let shapes = match &geometry {
        Some(g) => engine
            .query(&format!(
                "SELECT ST_AsGeoJSON({}) FROM {view} LIMIT {MAP_LIMIT}",
                qid(g)
            ))
            .await?
            .into_iter()
            .filter_map(|r| r[0].as_str().and_then(|t| serde_json::from_str(t).ok()))
            .collect(),
        None => vec![],
    };
    Ok(Table {
        columns: described
            .into_iter()
            .map(|c| format!("{} ({})", c.name, c.kind))
            .collect(),
        rows: rows
            .into_iter()
            .map(|r| {
                r.into_iter()
                    .map(|v| v.as_str().map(String::from).unwrap_or_else(|| "NULL".into()))
                    .collect()
            })
            .collect(),
        shapes,
    })
}
