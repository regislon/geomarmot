//! The desktop app's side of the engine process: start, cancel, kill, restart, recover
//! (docs/rust-migration-plan.md, Cancellation and Restart recovery).
//!
//! Every engine start increases the epoch; results carry the epoch they were computed
//! in, and the app drops any result from an older one. Cancel interrupts first; if the
//! work has not stopped within the grace period, the process is killed and a fresh one
//! started with the same sources.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use crate::process::ProcessEngine;
use crate::{Config, Result, SqlEngine, io, qid, qlit};
use geomarmot_sql::arrow::array::RecordBatch;

/// How long cooperative cancel may take before the process is killed (ADR 0004).
pub const STOP_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reader {
    Csv,
    Parquet,
    /// GeoPackage, GeoJSON, FlatGeobuf through the spatial extension.
    Gdal,
}

/// What the app keeps about a source so a fresh engine can register it again.
#[derive(Debug, Clone)]
pub struct SourceRecord {
    /// The relation the graph reads.
    pub name: String,
    /// The approved path or URL.
    pub location: String,
    pub reader: Reader,
    /// Size and mtime at load, for local files.
    pub fingerprint: Option<(u64, std::time::SystemTime)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceState {
    Ready,
    /// The file changed since it was loaded; the user reloads it explicitly.
    ChangedSinceLoaded,
    Missing(String),
}

pub struct Supervisor {
    binary: PathBuf,
    base: Config,
    test_hooks: bool,
    engine: RwLock<Arc<ProcessEngine>>,
    epoch: AtomicU64,
    in_flight: Arc<AtomicUsize>,
    sources: Mutex<Vec<SourceRecord>>,
}

/// A query result and the engine epoch it came from.
pub struct Tagged<T> {
    pub epoch: u64,
    pub value: Result<T>,
}

struct Busy(Arc<AtomicUsize>);
impl Drop for Busy {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Supervisor {
    pub fn start(binary: &Path, base: Config, test_hooks: bool) -> Result<Self> {
        if let Some(dir) = &base.staging_dir {
            io::clean_staging(dir)?;
        }
        let engine = ProcessEngine::spawn_with(binary, &base, test_hooks)?;
        Ok(Self {
            binary: binary.to_path_buf(),
            base,
            test_hooks,
            engine: RwLock::new(Arc::new(engine)),
            epoch: AtomicU64::new(1),
            in_flight: Arc::new(AtomicUsize::new(0)),
            sources: Mutex::new(Vec::new()),
        })
    }

    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// The current engine, and the epoch it belongs to.
    pub fn engine(&self) -> (u64, Arc<ProcessEngine>) {
        let engine = self.engine.read().unwrap().clone();
        (self.epoch(), engine)
    }

    fn busy(&self) -> Busy {
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        Busy(self.in_flight.clone())
    }

    pub fn query(&self, sql: &str) -> Tagged<Vec<RecordBatch>> {
        let (epoch, engine) = self.engine();
        let _busy = self.busy();
        Tagged {
            epoch,
            value: pollster::block_on(engine.query_arrow(sql)),
        }
    }

    pub fn exec(&self, sql: &str) -> Tagged<()> {
        let (epoch, engine) = self.engine();
        let _busy = self.busy();
        Tagged {
            epoch,
            value: pollster::block_on(engine.exec(sql)),
        }
    }

    /// Test-only: occupy the engine as a stuck kernel would.
    pub fn stuck(&self, seconds: u64) -> Tagged<()> {
        let (epoch, engine) = self.engine();
        let _busy = self.busy();
        Tagged {
            epoch,
            value: engine.stuck(seconds),
        }
    }

    /// Cancel: interrupt, wait up to `grace` for the work to stop, otherwise restart.
    /// Returns whether escalation (a restart) was needed.
    pub fn cancel(&self, grace: Duration) -> Result<bool> {
        let (_, engine) = self.engine();
        engine.interrupt()?;
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            if self.in_flight.load(Ordering::SeqCst) == 0 {
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        self.restart()?;
        Ok(true)
    }

    /// Approve a source: the allow list is fixed per process, so this restarts the engine.
    pub fn approve_source(&self, mut record: SourceRecord) -> Result<Vec<(String, SourceState)>> {
        record.fingerprint = io::fingerprint(&record.location);
        self.sources.lock().unwrap().push(record);
        self.restart()
    }

    /// Kill the engine, start a fresh one with every approved source, and register them again.
    pub fn restart(&self) -> Result<Vec<(String, SourceState)>> {
        let records = self.sources.lock().unwrap().clone();
        let mut config = self.base.clone();
        config.allowed_paths = records.iter().map(|r| r.location.clone()).collect();
        let old = self.engine.read().unwrap().clone();
        old.kill()?;
        if let Some(dir) = &config.staging_dir {
            io::clean_staging(dir)?;
        }
        let fresh = Arc::new(ProcessEngine::spawn_with(&self.binary, &config, self.test_hooks)?);
        let mut states = Vec::new();
        for r in &records {
            let state = match io::fingerprint(&r.location) {
                None if r.fingerprint.is_some() => SourceState::Missing("the file is gone".into()),
                now if r.fingerprint.is_some() && now != r.fingerprint => SourceState::ChangedSinceLoaded,
                _ => match pollster::block_on(fresh.exec(&register_sql(r))) {
                    Ok(()) => SourceState::Ready,
                    Err(e) => SourceState::Missing(e),
                },
            };
            states.push((r.name.clone(), state));
        }
        *self.engine.write().unwrap() = fresh;
        self.epoch.fetch_add(1, Ordering::SeqCst);
        Ok(states)
    }
}

/// The view that makes a source readable by name.
pub fn register_sql(r: &SourceRecord) -> String {
    let location = qlit(&r.location);
    let scan = match r.reader {
        Reader::Csv => format!("read_csv({location})"),
        Reader::Parquet => format!("read_parquet({location})"),
        Reader::Gdal => format!("ST_Read({location})"),
    };
    format!("CREATE OR REPLACE VIEW {} AS SELECT * FROM {scan}", qid(&r.name))
}
