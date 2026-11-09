//! The native engine host: DuckDB with the bundled extensions.
//!
//! Two entry points over the same host: in-process (`Host`, used by the CLI and
//! tests) and the `geomarmot-engine` binary served over a pipe (`process`), used by
//! the desktop app. Extensions are installed into a local directory once
//! (`install_extensions`); an engine only LOADs them from there, so a running engine
//! never fetches anything (docs/decisions/0002).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use duckdb::{Connection, InterruptHandle};
use geomarmot_sql::arrow::array::RecordBatch;
pub use geomarmot_sql::{Column, KernelRequest, OverlayRequest, OverlayStats, Result, SqlEngine, arrow, qid, qlit};

pub mod io;
mod kernels;
pub mod process;
pub mod supervisor;

/// Extensions loaded at boot. parquet and json are compiled into the bundled build.
pub const EXTENSIONS: &[&str] = &["spatial", "httpfs"];

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
    io::ensure_dir(dir)?;
    let c = Connection::open_in_memory().map_err(err)?;
    c.execute_batch(&format!("SET extension_directory = {};", qlit(&dir.to_string_lossy())))
        .map_err(err)?;
    for name in EXTENSIONS {
        c.execute_batch(&format!("INSTALL {name};")).map_err(err)?;
    }
    Ok(())
}

/// How an engine is allowed to touch the outside world (docs/rust-migration-plan.md, Security).
#[derive(Debug, Clone, Default)]
pub struct Config {
    /// Where the bundled extensions are; nothing else is ever loaded.
    pub extension_dir: PathBuf,
    /// Exact files and URLs the engine may read (approved sources).
    pub allowed_paths: Vec<String>,
    /// The engine's own staging directory (exports, snapshots); readable and writable.
    pub staging_dir: Option<PathBuf>,
    /// DuckDB memory_limit, e.g. "4GB".
    pub memory_limit: Option<String>,
}

/// The in-process engine.
pub struct Host {
    conn: Connection,
    /// What trusted I/O outside DuckDB (terrio) may touch: the same allow list.
    approvals: io::Approvals,
    /// Set by an interrupt; kernels check it between tasks.
    cancel: Arc<AtomicBool>,
}

impl Host {
    /// Boot a locked engine: extensions from `extension_dir` only, file and network access limited
    /// to `allowed_paths` and the staging directory, and no setting can change afterwards.
    pub fn open(config: &Config) -> Result<Self> {
        let conn = Connection::open_in_memory().map_err(err)?;
        let list = |items: &[String]| items.iter().map(|p| qlit(p)).collect::<Vec<_>>().join(", ");
        let mut boot = format!(
            "SET extension_directory = {};
             SET autoinstall_known_extensions = false;
             SET autoload_known_extensions = false;
             SET allow_persistent_secrets = false;",
            qlit(&config.extension_dir.to_string_lossy())
        );
        for name in EXTENSIONS {
            boot.push_str(&format!("LOAD {name};"));
        }
        conn.execute_batch(&boot).map_err(|e| {
            format!(
                "could not load the bundled extensions from {}: {e}",
                config.extension_dir.display()
            )
        })?;
        let mut lock = String::new();
        if let Some(limit) = &config.memory_limit {
            lock.push_str(&format!("SET memory_limit = {};", qlit(limit)));
        }
        if let Some(dir) = &config.staging_dir {
            if !dir.is_dir() {
                return Err(format!("staging directory {} does not exist", dir.display()));
            }
            let dir = format!("{}/", dir.to_string_lossy().trim_end_matches('/'));
            lock.push_str(&format!(
                "SET temp_directory = {}; SET allowed_directories = [{}];",
                qlit(&dir),
                qlit(&dir)
            ));
        }
        if !config.allowed_paths.is_empty() {
            lock.push_str(&format!("SET allowed_paths = [{}];", list(&config.allowed_paths)));
        }
        lock.push_str("SET enable_external_access = false; SET lock_configuration = true;");
        conn.execute_batch(&lock).map_err(err)?;
        let approvals = io::Approvals {
            sources: config.allowed_paths.clone(),
            staging_dir: config.staging_dir.clone(),
        };
        Ok(Self {
            conn,
            approvals,
            cancel: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Stops the running statement of this engine, from any thread.
    pub fn interrupt_handle(&self) -> Arc<InterruptHandle> {
        self.conn.interrupt_handle()
    }

    /// Stops a running kernel between tasks, from any thread.
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    pub fn overlay_now(&self, request: &OverlayRequest) -> Result<OverlayStats> {
        let result = kernels::overlay(self, request, &self.cancel);
        self.cancel.store(false, Ordering::SeqCst);
        result
    }

    /// Create `table` from Arrow batches (trusted I/O: terrio readers, kernel results). Uses the
    /// appender, not DuckDB's `arrow()` table function, which would let SQL pass raw pointers.
    pub fn create_from_arrow(
        &self,
        table: &str,
        schema: &arrow::datatypes::Schema,
        batches: &[RecordBatch],
    ) -> Result<()> {
        let columns: Vec<String> = schema
            .fields()
            .iter()
            .map(|f| Ok(format!("{} {}", qid(f.name()), duckdb_type(f.data_type())?)))
            .collect::<Result<_>>()?;
        self.exec_now(&format!(
            "CREATE OR REPLACE TABLE {} ({})",
            qid(table),
            columns.join(", ")
        ))?;
        let mut appender = self.conn.appender(table).map_err(err)?;
        for batch in batches {
            appender.append_record_batch(batch.clone()).map_err(err)?;
        }
        appender.flush().map_err(err)
    }

    /// Read the first layer of a vector file with terrio into `table` (geometry as GEOMETRY in
    /// `geometry`). Returns the layer's CRS. DuckDB itself never opens the file.
    // ponytail: first layer only; one source per layer, as the JavaScript Reader does, comes with the I/O phase.
    pub fn import_now(&self, table: &str, path: &str) -> Result<Option<String>> {
        self.approvals.authorize(path, io::Access::Read)?;
        let layers = geomarmot_io::read_vector(path)?;
        let layer = layers.first().ok_or_else(|| format!("{path} has no layer"))?;
        let raw = format!("{table}__raw");
        self.create_from_arrow(&raw, &layer.schema, &layer.batches)?;
        self.exec_now(&format!(
            "CREATE OR REPLACE TABLE {} AS SELECT * REPLACE (ST_GeomFromWKB(geometry) AS geometry) FROM {}; DROP TABLE {};",
            qid(table),
            qid(&raw),
            qid(&raw)
        ))?;
        Ok(layer.crs.clone())
    }

    pub fn exec_now(&self, sql: &str) -> Result<()> {
        self.conn.execute_batch(sql).map_err(err)
    }

    pub fn query_now(&self, sql: &str) -> Result<Vec<RecordBatch>> {
        let mut stmt = self.conn.prepare(sql).map_err(err)?;
        Ok(stmt.query_arrow([]).map_err(err)?.collect())
    }
}

impl SqlEngine for Host {
    async fn exec(&self, sql: &str) -> Result<()> {
        self.exec_now(sql)
    }

    async fn query_arrow(&self, sql: &str) -> Result<Vec<RecordBatch>> {
        self.query_now(sql)
    }

    async fn overlay(&self, request: &OverlayRequest) -> Result<OverlayStats> {
        self.overlay_now(request)
    }

    async fn insert_arrow(&self, table: &str, batches: &[RecordBatch]) -> Result<()> {
        let schema = batches.first().map(|b| b.schema()).ok_or("no batches")?;
        self.create_from_arrow(table, &schema, batches)
    }

    async fn kernel(&self, request: &KernelRequest) -> Result<()> {
        geomarmot_kernels::features::drive(self, request).await
    }
}

/// The DuckDB column type for an Arrow type the readers produce.
fn duckdb_type(t: &arrow::datatypes::DataType) -> Result<&'static str> {
    use arrow::datatypes::DataType as D;
    Ok(match t {
        D::Boolean => "BOOLEAN",
        D::Int8 => "TINYINT",
        D::Int16 => "SMALLINT",
        D::Int32 => "INTEGER",
        D::Int64 => "BIGINT",
        D::UInt8 => "UTINYINT",
        D::UInt16 => "USMALLINT",
        D::UInt32 => "UINTEGER",
        D::UInt64 => "UBIGINT",
        D::Float32 => "FLOAT",
        D::Float64 => "DOUBLE",
        D::Utf8 | D::LargeUtf8 | D::Utf8View => "VARCHAR",
        D::Binary | D::LargeBinary | D::BinaryView => "BLOB",
        D::Date32 => "DATE",
        D::Timestamp(_, None) => "TIMESTAMP",
        D::Timestamp(_, Some(_)) => "TIMESTAMPTZ",
        other => return Err(format!("no DuckDB column type for Arrow {other}")),
    })
}
