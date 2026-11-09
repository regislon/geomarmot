//! The native engine host: DuckDB with the bundled extensions.
//!
//! Spike scope: the in-process host only (no engine process, no allow list yet).
//! Extensions are installed into a local directory once (`install_extensions`),
//! then every engine only LOADs them from there, so a running engine never
//! fetches anything (the offline rule, docs/decisions/0002).

use std::path::Path;

use duckdb::Connection;
use duckdb::types::Value as Dv;
use serde_json::Value;

/// Extensions loaded at boot. parquet and json are compiled into the bundled build.
pub const EXTENSIONS: &[&str] = &["spatial"];

pub type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Column {
    pub name: String,
    /// Upper-cased DuckDB type, as `DESCRIBE` prints it.
    pub kind: String,
}

pub struct Engine {
    conn: Connection,
}

fn err(e: duckdb::Error) -> String {
    e.to_string()
}

/// `SELECT version()` and the platform string extensions are built for.
pub fn version_and_platform() -> Result<(String, String)> {
    let c = Connection::open_in_memory().map_err(err)?;
    c.query_row("SELECT version(), (SELECT platform FROM pragma_platform())", [], |r| {
        Ok((r.get(0)?, r.get(1)?))
    })
    .map_err(err)
}

/// Download the extensions into `dir` (a build/setup step, never done by a running engine).
pub fn install_extensions(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let c = Connection::open_in_memory().map_err(err)?;
    c.execute_batch(&format!("SET extension_directory = {};", qlit(&dir.to_string_lossy())))
        .map_err(err)?;
    for name in EXTENSIONS {
        c.execute_batch(&format!("INSTALL {name};")).map_err(err)?;
    }
    Ok(())
}

impl Engine {
    /// Boot an engine that loads its extensions from `extension_dir` and nowhere else.
    pub fn open(extension_dir: &Path) -> Result<Self> {
        let conn = Connection::open_in_memory().map_err(err)?;
        conn.execute_batch(&format!(
            "SET extension_directory = {};
             SET autoinstall_known_extensions = false;
             SET autoload_known_extensions = false;",
            qlit(&extension_dir.to_string_lossy())
        ))
        .map_err(err)?;
        for name in EXTENSIONS {
            conn.execute_batch(&format!("LOAD {name};")).map_err(|e| {
                format!(
                    "could not load the bundled {name} extension from {}: {e}",
                    extension_dir.display()
                )
            })?;
        }
        Ok(Self { conn })
    }

    pub fn exec(&self, sql: &str) -> Result<()> {
        self.conn.execute_batch(sql).map_err(err)
    }

    /// Rows as JSON values, in column order.
    pub fn query(&self, sql: &str) -> Result<Vec<Vec<Value>>> {
        let mut stmt = self.conn.prepare(sql).map_err(err)?;
        let mut rows = stmt.query([]).map_err(err)?;
        let width = rows.as_ref().map(|s| s.column_count()).unwrap_or(0);
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(err)? {
            let mut cells = Vec::with_capacity(width);
            for k in 0..width {
                cells.push(to_json(row.get::<_, Dv>(k).map_err(err)?));
            }
            out.push(cells);
        }
        Ok(out)
    }

    /// Columns of a table or view.
    pub fn describe(&self, relation: &str) -> Result<Vec<Column>> {
        Ok(self
            .query(&format!("SELECT column_name, column_type FROM (DESCRIBE {relation})"))?
            .into_iter()
            .map(|r| Column {
                name: r[0].as_str().unwrap_or_default().to_string(),
                kind: r[1].as_str().unwrap_or_default().to_uppercase(),
            })
            .collect())
    }
}

fn to_json(v: Dv) -> Value {
    match v {
        Dv::Null => Value::Null,
        Dv::Boolean(b) => b.into(),
        Dv::TinyInt(n) => n.into(),
        Dv::SmallInt(n) => n.into(),
        Dv::Int(n) => n.into(),
        Dv::BigInt(n) => n.into(),
        Dv::UTinyInt(n) => n.into(),
        Dv::USmallInt(n) => n.into(),
        Dv::UInt(n) => n.into(),
        Dv::UBigInt(n) => n.into(),
        Dv::Float(f) => serde_json::Number::from_f64(f as f64).map_or(Value::Null, Value::Number),
        Dv::Double(f) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        Dv::Text(s) => s.into(),
        other => format!("{other:?}").into(),
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
