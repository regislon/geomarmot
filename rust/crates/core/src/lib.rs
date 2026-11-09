//! Graph compilation and the transformers (spike: the five gate-1 transformers).
//!
//! A transformer is a port of `transformers/<id>/index.js`: the same hooks
//! (sql → crs → check, docs/transformer-api.md) producing the same DuckDB SQL.

use std::collections::BTreeMap;

pub use geomarmot_sql::{Column, Result, SqlEngine, qid, qlit};
use serde_json::Value;

mod compile;
pub mod transformers;

pub use compile::{NodeOutput, Probe, compile_node};

/// SQL per output port.
pub type Ports = BTreeMap<String, String>;

pub const LONLAT: &str = "EPSG:4326";

/// What a hook sees: the node's params, its input relations and their schemas.
pub struct Ctx {
    pub node_type: String,
    pub params: Value,
    pub inputs: BTreeMap<String, String>,
    pub schemas: BTreeMap<String, Vec<Column>>,
    pub incoming_crs: String,
}

impl Ctx {
    pub fn input(&self, port: &str) -> &str {
        self.inputs.get(port).map(String::as_str).unwrap_or_default()
    }

    pub fn schema(&self, port: &str) -> &[Column] {
        self.schemas.get(port).map(Vec::as_slice).unwrap_or_default()
    }

    /// A string param, "" when absent (JS `params.x || ""`).
    pub fn str(&self, id: &str) -> &str {
        self.params.get(id).and_then(Value::as_str).unwrap_or_default()
    }

    /// A list param as strings, skipping blanks and non-strings.
    pub fn strings(&self, id: &str) -> Vec<String> {
        self.params
            .get(id)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default()
    }
}

pub trait Transformer: Sync {
    fn id(&self) -> &'static str;
    fn inputs(&self) -> &'static [&'static str] {
        &["input"]
    }
    fn outputs(&self, _params: &Value) -> Vec<String> {
        vec!["output".into()]
    }
    /// Whether the compiler must DESCRIBE the inputs first (`needs.schema`).
    fn needs_schema(&self) -> bool {
        false
    }
    fn sql(&self, ctx: &Ctx) -> Result<Ports>;
    fn crs(&self, ctx: &Ctx) -> String {
        ctx.incoming_crs.clone()
    }
    /// The `check` hook as data: a probe query the compiler runs, and how to word its failure.
    fn check(&self, _ctx: &Ctx) -> Option<Probe> {
        None
    }
}

/// The geometry column of a schema: a GEOMETRY, or a BLOB with a geometry-like name (WKB).
pub struct GeometryColumn {
    pub name: String,
    pub wkb: bool,
}

const GEOMETRY_COLUMN_NAMES: &[&str] = &["geometry", "geom", "the_geom", "wkb_geometry", "geometry_wkb", "wkb"];

pub fn find_geometry_column(columns: &[Column]) -> Option<GeometryColumn> {
    if let Some(c) = columns.iter().find(|c| c.kind == "GEOMETRY") {
        return Some(GeometryColumn {
            name: c.name.clone(),
            wkb: false,
        });
    }
    columns
        .iter()
        .find(|c| c.kind == "BLOB" && GEOMETRY_COLUMN_NAMES.contains(&c.name.to_lowercase().as_str()))
        .map(|c| GeometryColumn {
            name: c.name.clone(),
            wkb: true,
        })
}

/// SQL yielding a GEOMETRY for the column.
pub fn geometry_expression(g: &GeometryColumn) -> String {
    if g.wkb {
        format!("ST_GeomFromWKB({})", qid(&g.name))
    } else {
        qid(&g.name)
    }
}

/// Move a geometry expression between CRSs (always_xy: PROJ would swap EPSG:4326 axes otherwise).
pub fn to_crs(expression: &str, from: &str, to: &str) -> String {
    if from == to {
        return expression.to_string();
    }
    format!(
        "ST_Transform({expression}, {}, {}, always_xy := true)",
        qlit(from),
        qlit(to)
    )
}

/// JavaScript's `Number(text)`: trimmed, "" is 0, anything else must parse.
pub fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) if s.trim().is_empty() => Some(0.0),
        Value::String(s) => s.trim().parse::<f64>().ok().filter(|f| f.is_finite()),
        Value::Null => Some(0.0),
        _ => None,
    }
}
