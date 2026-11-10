//! Graph compilation and the transformers (spike: the five gate-1 transformers).
//!
//! A transformer is a port of `transformers/<id>/index.js`: the same hooks
//! (sql → crs → check, docs/transformer-api.md) producing the same DuckDB SQL.

use std::collections::BTreeMap;

pub use geomarmot_sql::{Column, KernelRequest, OverlayRequest, RasterRequest, Result, SqlEngine, qid, qlit};
use serde_json::Value;

mod compile;
pub mod graph;
pub mod h3;
pub mod sqlguard;
pub mod transformers;
pub mod valuespec;

pub use compile::{NodeOutput, Probe, Step, compile_node, compile_node_from};

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
    /// Rows of the first input, when the transformer asks (`needs.rowCount`).
    pub row_count: Option<u64>,
    /// Names the node's own tables (`table_name`).
    pub prefix: String,
    /// The file name of the source upstream, when a Reader feeds this node (`ctx.source.name`).
    pub source: Option<String>,
}

impl Ctx {
    pub fn input(&self, port: &str) -> &str {
        self.inputs.get(port).map(String::as_str).unwrap_or_default()
    }

    pub fn schema(&self, port: &str) -> &[Column] {
        self.schemas.get(port).map(Vec::as_slice).unwrap_or_default()
    }

    /// A table this node owns, stable between `prepare` and `sql`.
    pub fn table_name(&self, suffix: &str) -> String {
        format!("{}_t_{suffix}", self.prefix)
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

/// How a parameter is edited (the JavaScript `param.*` kinds the ported transformers use).
#[derive(Debug, Clone, Copy)]
pub enum Kind {
    /// Free text; `units` shown after the field.
    String {
        placeholder: &'static str,
        units: &'static str,
    },
    /// One of these (value, description).
    Select(&'static [(&'static str, &'static str)]),
    /// One attribute of the input port.
    Column { port: &'static str },
    /// Several attributes of the input port, in the input's order.
    Columns { port: &'static str },
    /// Several of fixed choices (`param.choices`), with the ones on by default.
    Choices {
        choices: &'static [&'static str],
        default: &'static [&'static str],
    },
    /// A list of literal values, with "Fill from data" from the `column` parameter.
    Values,
    /// Pairs of attributes, `left` = `right`, from the `left` and `right` ports.
    JoinKeys,
    /// A constant, an attribute, a formula or SQL (`param.valuespec`, `valuespec::value_sql`).
    ValueSpec,
    /// A list of rows, each an object with these fields (`conditions`, `rules`, `aggregates`).
    Rows(&'static [(&'static str, Cell)]),
    /// A query written by the user (`sqltext`/`sqlcreate`); the SQL guard checks it.
    SqlText { placeholder: &'static str },
    /// Rows `{from, to}`: an attribute of `input` and its new name.
    Renames,
    /// Rows `{column, direction}`: ASC or DESC.
    Sorts,
    /// Rows `{name, value}`, `value` a value spec (`valuerows`).
    ValueRows,
    /// AttributeManager's edits: rows `{action, column, target, to, spec}`.
    Actions,
}

/// One field of a `Kind::Rows` row.
#[derive(Debug, Clone, Copy)]
pub enum Cell {
    /// An attribute of the `input` port.
    Column,
    /// One of these values.
    Pick(&'static [&'static str]),
    /// Free text.
    Text,
}

/// One parameter of a transformer: what the inspector draws, and its default.
#[derive(Debug, Clone, Copy)]
pub struct Param {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: Kind,
    pub default: &'static str,
    pub description: &'static str,
}

impl Param {
    pub const fn new(id: &'static str, label: &'static str, kind: Kind, description: &'static str) -> Self {
        Self {
            id,
            label,
            kind,
            default: "",
            description,
        }
    }

    pub const fn default(mut self, default: &'static str) -> Self {
        self.default = default;
        self
    }
}

/// Params with every default filled in, as a new node starts.
pub fn default_params(t: &dyn Transformer) -> Value {
    let mut out = serde_json::Map::new();
    for p in t.params() {
        let v = match p.kind {
            Kind::Columns { .. }
            | Kind::Values
            | Kind::Rows(_)
            | Kind::Renames
            | Kind::Sorts
            | Kind::ValueRows
            | Kind::Actions => Value::Array(vec![]),
            Kind::JoinKeys => serde_json::json!([{ "left": "", "right": "" }]),
            Kind::ValueSpec => Value::Null,
            Kind::Choices { default, .. } => serde_json::json!(default),
            _ => Value::String(p.default.into()),
        };
        out.insert(p.id.into(), v);
    }
    Value::Object(out)
}

pub trait Transformer: Sync {
    fn id(&self) -> &'static str;
    /// One line on what it does (the inspector's hint).
    fn summary(&self) -> &'static str {
        ""
    }
    /// Its parameters, in the inspector's order.
    fn params(&self) -> &'static [Param] {
        &[]
    }
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
    /// The compiler counts the first input's rows first (`needs.rowCount`).
    fn needs_row_count(&self) -> bool {
        false
    }
    /// Inputs must be in longitude/latitude (`needs.lonLat`).
    fn needs_lonlat(&self) -> bool {
        false
    }
    /// The `prepare` hook as data: steps the compiler runs before `sql`.
    fn prepare(&self, _ctx: &Ctx) -> Result<Vec<Step>> {
        Ok(vec![])
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
    // DuckDB 1.5 writes the CRS into the type: GEOMETRY('EPSG:4326').
    if let Some(c) = columns
        .iter()
        .find(|c| c.kind == "GEOMETRY" || c.kind.starts_with("GEOMETRY("))
    {
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

/// A count as JavaScript's `toLocaleString()` writes it in English: 200,000.
pub fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// The CRS codes that mean longitude/latitude (`isLonLatCode`).
pub fn is_lonlat(code: &str) -> bool {
    ["EPSG:4326", "OGC:CRS84", "CRS84", "WGS 84", "WGS84"].contains(&code)
}
