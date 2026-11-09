//! The native engine host: DuckDB with the bundled extensions.
//!
//! Two entry points over the same host: in-process (`Host`, used by the CLI and
//! tests) and the `geomarmot-engine` binary served over a pipe (`process`), used by
//! the desktop app. Extensions are installed into a local directory once
//! (`install_extensions`); an engine only LOADs them from there, so a running engine
//! never fetches anything (docs/decisions/0002).

use std::path::Path;
use std::sync::Arc;

use duckdb::{Connection, InterruptHandle};
use geomarmot_sql::arrow::array::RecordBatch;
pub use geomarmot_sql::{Column, Result, SqlEngine, arrow, qid, qlit};

pub mod process;

/// Extensions loaded at boot. parquet and json are compiled into the bundled build.
pub const EXTENSIONS: &[&str] = &["spatial"];

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

/// The in-process engine.
pub struct Host {
    conn: Connection,
}

impl Host {
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

    /// Stops the running statement of this engine, from any thread.
    pub fn interrupt_handle(&self) -> Arc<InterruptHandle> {
        self.conn.interrupt_handle()
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
}
