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
use geomarmot_core::{SqlEngine, is_lonlat, qid, to_crs};
use serde_json::Value;

pub enum Job {
    Open(PathBuf),
    /// Run (compile and cache) a graph; replies `Compiled`.
    Run(Graph),
    Read {
        view: String,
        /// The view's CRS; the map draws in longitude/latitude.
        crs: String,
        /// First row of the page.
        offset: usize,
    },
    Export {
        view: String,
        to: PathBuf,
    },
    /// A small query for the inspector (attributes of an input, distinct values); replies `Rows`.
    Rows {
        key: String,
        sql: String,
    },
    /// Attribute names of output `port` of `node`, compiling `graph` without running it; replies `Rows`.
    Columns {
        key: String,
        graph: Graph,
        node: usize,
        port: usize,
    },
    /// Run a statement for its effect (the probe's workload).
    Exec(String),
    /// The browser: a file the user picked, as bytes.
    OpenBytes {
        name: String,
        bytes: Vec<u8>,
    },
}

/// One row of the attribute table.
#[derive(Clone)]
pub struct Row {
    /// The row's id in its (cached) table: the map's features carry the same id.
    pub id: i64,
    pub cells: Vec<String>,
    /// Its geometry as GeoJSON in longitude/latitude, if any.
    pub shape: Option<Value>,
}

/// A page of a view, and on the first page the features for the map.
pub struct Table {
    pub columns: Vec<String>,
    pub kinds: Vec<String>,
    pub total: usize,
    pub offset: usize,
    pub rows: Vec<Row>,
    /// The geometry column's name (not in `columns`: the map shows it).
    pub geometry: Option<String>,
    /// (row id, GeoJSON) for the map, up to `MAP_LIMIT`; only read with the first page.
    pub shapes: Option<Vec<(i64, Value)>>,
}

pub enum Reply {
    Opened {
        relation: String,
        label: String,
        /// The file's path on the desktop (None in the browser).
        path: Option<String>,
    },
    Compiled {
        generation: u64,
        states: std::collections::BTreeMap<usize, NodeState>,
    },
    Read {
        view: String,
        table: Result<Table, String>,
    },
    Rows {
        key: String,
        rows: Result<Vec<Vec<Value>>, String>,
    },
    Status(String),
}

pub const PAGE: usize = 50;
pub const MAP_LIMIT: usize = 8_000;

fn int(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_str()?.parse().ok())
}

/// A page of `view` (ordered by row id), its row count, and with the first page the map's
/// features. Rows and features share `rowid`: every view the app reads is a cached table.
async fn read(engine: &impl SqlEngine, view: &str, crs: &str, offset: usize) -> Result<Table, String> {
    let described = engine.describe(view).await?;
    let geometry = described
        .iter()
        .find(|c| c.kind.starts_with("GEOMETRY"))
        .map(|c| c.name.clone());
    let attributes: Vec<_> = described
        .iter()
        .filter(|c| Some(&c.name) != geometry.as_ref())
        .collect();
    let shape = match &geometry {
        Some(g) if crs.is_empty() || is_lonlat(crs) => format!("ST_AsGeoJSON({})", qid(g)),
        Some(g) => format!("ST_AsGeoJSON({})", to_crs(&qid(g), crs, "EPSG:4326")),
        None => "NULL".into(),
    };
    let mut select = vec!["rowid".to_string(), shape.clone()];
    select.extend(attributes.iter().map(|c| format!("{}::VARCHAR", qid(&c.name))));
    let total = engine
        .query(&format!("SELECT count(*) FROM {view}"))
        .await?
        .first()
        .and_then(|r| int(&r[0]))
        .unwrap_or(0) as usize;
    let rows = engine
        .query(&format!(
            "SELECT {} FROM {view} ORDER BY rowid LIMIT {PAGE} OFFSET {offset}",
            select.join(", ")
        ))
        .await?
        .into_iter()
        .map(|r| Row {
            id: int(&r[0]).unwrap_or(-1),
            shape: r[1].as_str().and_then(|t| serde_json::from_str(t).ok()),
            cells: r[2..]
                .iter()
                .map(|v| v.as_str().map(String::from).unwrap_or_else(|| "NULL".into()))
                .collect(),
        })
        .collect();
    let shapes = if geometry.is_some() && offset == 0 {
        Some(
            engine
                .query(&format!(
                    "SELECT rowid, {shape} FROM {view} ORDER BY rowid LIMIT {MAP_LIMIT}"
                ))
                .await?
                .into_iter()
                .filter_map(|r| Some((int(&r[0])?, serde_json::from_str(r[1].as_str()?).ok()?)))
                .collect(),
        )
    } else {
        None
    };
    Ok(Table {
        columns: attributes.iter().map(|c| c.name.clone()).collect(),
        kinds: attributes.iter().map(|c| c.kind.clone()).collect(),
        total,
        offset,
        rows,
        geometry,
        shapes,
    })
}
