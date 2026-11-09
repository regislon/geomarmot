//! The boundary between the compiler and an engine.
//!
//! One trait, three implementations (docs/rust-migration-plan.md, "Native engine host"):
//! the in-process native host, the client of an engine process, and the DuckDB-Wasm
//! bridge. Results cross every boundary as Arrow record batches; the Arrow IPC stream
//! format is how they travel between processes and workers.

use arrow::array::{Array, AsArray, RecordBatch};
use arrow::datatypes::{DataType, Float32Type, Float64Type, Int8Type, Int16Type, Int32Type, Int64Type};
use arrow::datatypes::{UInt8Type, UInt16Type, UInt32Type, UInt64Type};
use arrow::ipc::reader::StreamReader;
use arrow::ipc::writer::StreamWriter;
use arrow::util::display::array_value_to_string;
use serde_json::Value;

pub use arrow;

pub type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Column {
    pub name: String,
    /// Upper-cased DuckDB type, as `DESCRIBE` prints it.
    pub kind: String,
}

/// A request to the overlay kernel. Names are quoted SQL; the three outputs are tables it creates:
/// faces (face_id, geometry), memberships (face_id, fid), ambiguous (geometry, area, clearance).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OverlayRequest {
    pub source: String,
    pub fid: String,
    pub geometry: String,
    pub faces: String,
    pub memberships: String,
    pub ambiguous: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OverlayStats {
    pub faces: usize,
    pub ambiguous: usize,
    pub parts: usize,
    pub tasks: usize,
}

impl OverlayRequest {
    /// One line per field, for the engine-process protocol.
    pub fn encode(&self) -> String {
        [
            &self.source,
            &self.fid,
            &self.geometry,
            &self.faces,
            &self.memberships,
            &self.ambiguous,
        ]
        .map(|s| s.replace('\n', " "))
        .join("\n")
    }

    pub fn decode(text: &str) -> Result<Self> {
        let f: Vec<&str> = text.split('\n').collect();
        let [source, fid, geometry, faces, memberships, ambiguous] = f[..] else {
            return Err("malformed overlay request".into());
        };
        Ok(Self {
            source: source.into(),
            fid: fid.into(),
            geometry: geometry.into(),
            faces: faces.into(),
            memberships: memberships.into(),
            ambiguous: ambiguous.into(),
        })
    }
}

impl OverlayStats {
    pub fn encode(&self) -> String {
        format!("{} {} {} {}", self.faces, self.ambiguous, self.parts, self.tasks)
    }

    pub fn decode(text: &str) -> Result<Self> {
        let n: Vec<usize> = text.split(' ').filter_map(|x| x.parse().ok()).collect();
        let [faces, ambiguous, parts, tasks] = n[..] else {
            return Err("malformed overlay stats".into());
        };
        Ok(Self {
            faces,
            ambiguous,
            parts,
            tasks,
        })
    }
}

/// A per-feature kernel: `input_sql` returns (key, value) rows; the kernel turns each value into a
/// geometry, and `output` becomes a table (key, geometry). `op` names the kernel
/// (`geomarmot_kernels::features`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct KernelRequest {
    pub op: String,
    pub input_sql: String,
    pub output: String,
}

impl KernelRequest {
    pub fn encode(&self) -> String {
        [&self.op, &self.output, &self.input_sql]
            .map(|s| s.replace('\n', " "))
            .join("\n")
    }

    pub fn decode(text: &str) -> Result<Self> {
        let mut f = text.splitn(3, '\n');
        match (f.next(), f.next(), f.next()) {
            (Some(op), Some(output), Some(input_sql)) => Ok(Self {
                op: op.into(),
                output: output.into(),
                input_sql: input_sql.into(),
            }),
            _ => Err("malformed kernel request".into()),
        }
    }
}

/// What the compiler needs from an engine. Async because the browser's engine is.
#[allow(async_fn_in_trait)]
pub trait SqlEngine {
    async fn exec(&self, sql: &str) -> Result<()>;
    async fn query_arrow(&self, sql: &str) -> Result<Vec<RecordBatch>>;

    /// Create `table` from Arrow batches (trusted: kernel results).
    async fn insert_arrow(&self, _table: &str, _batches: &[RecordBatch]) -> Result<()> {
        Err("This engine cannot take Arrow data.".into())
    }

    /// Run a per-feature kernel next to the data.
    async fn kernel(&self, _request: &KernelRequest) -> Result<()> {
        Err("This engine has no kernels.".into())
    }

    /// Run the overlay kernel next to the data.
    async fn overlay(&self, _request: &OverlayRequest) -> Result<OverlayStats> {
        Err("This engine has no overlay kernel.".into())
    }

    /// Rows as JSON values, in column order.
    async fn query(&self, sql: &str) -> Result<Vec<Vec<Value>>> {
        Ok(rows(&self.query_arrow(sql).await?))
    }

    /// Columns of a table or view.
    async fn describe(&self, relation: &str) -> Result<Vec<Column>> {
        let found = self
            .query(&format!("SELECT column_name, column_type FROM (DESCRIBE {relation})"))
            .await?;
        Ok(found
            .into_iter()
            .map(|r| Column {
                name: r[0].as_str().unwrap_or_default().to_string(),
                kind: r[1].as_str().unwrap_or_default().to_uppercase(),
            })
            .collect())
    }
}

/// Quote an identifier.
pub fn qid(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Quote a string literal.
pub fn qlit(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn cell(a: &dyn Array, i: usize) -> Value {
    if a.is_null(i) {
        return Value::Null;
    }
    let f = |x: f64| serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number);
    match a.data_type() {
        DataType::Boolean => a.as_boolean().value(i).into(),
        DataType::Int8 => a.as_primitive::<Int8Type>().value(i).into(),
        DataType::Int16 => a.as_primitive::<Int16Type>().value(i).into(),
        DataType::Int32 => a.as_primitive::<Int32Type>().value(i).into(),
        DataType::Int64 => a.as_primitive::<Int64Type>().value(i).into(),
        DataType::UInt8 => a.as_primitive::<UInt8Type>().value(i).into(),
        DataType::UInt16 => a.as_primitive::<UInt16Type>().value(i).into(),
        DataType::UInt32 => a.as_primitive::<UInt32Type>().value(i).into(),
        DataType::UInt64 => a.as_primitive::<UInt64Type>().value(i).into(),
        DataType::Float32 => f(a.as_primitive::<Float32Type>().value(i) as f64),
        DataType::Float64 => f(a.as_primitive::<Float64Type>().value(i)),
        DataType::Utf8 => a.as_string::<i32>().value(i).into(),
        DataType::LargeUtf8 => a.as_string::<i64>().value(i).into(),
        DataType::Utf8View => a.as_string_view().value(i).into(),
        _ => array_value_to_string(a, i).map(Value::from).unwrap_or(Value::Null),
    }
}

/// Plain rows from record batches.
pub fn rows(batches: &[RecordBatch]) -> Vec<Vec<Value>> {
    let mut out = Vec::new();
    for b in batches {
        for i in 0..b.num_rows() {
            out.push(b.columns().iter().map(|c| cell(c.as_ref(), i)).collect());
        }
    }
    out
}

/// Batches as one Arrow IPC stream. An empty result still carries its schema when there is a batch.
pub fn to_ipc(batches: &[RecordBatch]) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    if let Some(first) = batches.first() {
        let mut w = StreamWriter::try_new(&mut buf, &first.schema()).map_err(|e| e.to_string())?;
        for b in batches {
            w.write(b).map_err(|e| e.to_string())?;
        }
        w.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf)
}

pub fn from_ipc(bytes: &[u8]) -> Result<Vec<RecordBatch>> {
    if bytes.is_empty() {
        return Ok(vec![]);
    }
    StreamReader::try_new(bytes, None)
        .map_err(|e| e.to_string())?
        .map(|b| b.map_err(|e| e.to_string()))
        .collect()
}
