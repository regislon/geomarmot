//! Desktop: the engine process, driven from a background thread so the UI never waits on it.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};

use geomarmot_core::graph::{drop_generation, run_graph};
use geomarmot_core::{SqlEngine, qid, qlit};
use serde_json::{Value, json};

use super::{Job, Reply};
use geomarmot_engine::io::{Approvals, finalize_export};
use geomarmot_engine::supervisor::{Reader, SourceRecord, SourceState, Supervisor};

pub struct Worker {
    jobs: Sender<Job>,
    pub replies: Receiver<Reply>,
    supervisor: Arc<Supervisor>,
}

impl Worker {
    pub fn start(supervisor: Supervisor, staging: PathBuf, wake: impl Fn() + Send + 'static) -> Self {
        let supervisor = Arc::new(supervisor);
        let (jobs, inbox) = channel();
        let (outbox, replies) = channel();
        let s = supervisor.clone();
        std::thread::spawn(move || {
            let mut generation = 0;
            let mut sources = 0;
            for job in inbox {
                let reply = run(&s, &staging, job, &mut generation, &mut sources);
                if outbox.send(reply).is_err() {
                    break;
                }
                wake();
            }
        });
        Self {
            jobs,
            replies,
            supervisor,
        }
    }

    pub fn send(&self, job: Job) {
        let _ = self.jobs.send(job);
    }

    /// Cancel runs on the UI's side of the channel: the worker is busy with the job to cancel.
    pub fn cancel(&self) -> String {
        match self.supervisor.cancel(geomarmot_engine::supervisor::STOP_GRACE) {
            Ok(true) => "Stopped (the engine was restarted).".into(),
            Ok(false) => "Stopped.".into(),
            Err(e) => format!("Could not cancel: {e}"),
        }
    }
}

fn reader_for(path: &Path) -> Reader {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_lowercase()
        .as_str()
    {
        "csv" | "tsv" => Reader::Csv,
        "parquet" | "pq" => Reader::Parquet,
        "tif" | "tiff" => Reader::Raster,
        _ => Reader::Vector,
    }
}

fn run(s: &Supervisor, staging: &Path, job: Job, generation: &mut u64, sources: &mut usize) -> Reply {
    let (_, engine) = s.engine();
    match job {
        Job::Open(path) => {
            *sources += 1;
            let relation = format!("src_{sources}");
            let record = SourceRecord {
                name: relation.clone(),
                location: path.to_string_lossy().into_owned(),
                reader: reader_for(&path),
                fingerprint: None,
            };
            let label: String = path.file_name().unwrap_or_default().to_string_lossy().into();
            let params = json!({ "path": path.to_string_lossy() });
            approve(s, record, label, params)
        }
        Job::OpenUrl(url) => {
            *sources += 1;
            let relation = format!("src_{sources}");
            let path = url.split(['?', '#']).next().unwrap_or_default();
            let record = SourceRecord {
                name: relation,
                location: url.clone(),
                reader: reader_for(Path::new(path)),
                fingerprint: None,
            };
            let label = path.rsplit('/').next().unwrap_or(path).to_string();
            approve(s, record, label, json!({ "url": url }))
        }
        Job::OpenDb {
            connection,
            location,
            label,
            params,
        } => {
            *sources += 1;
            let relation = format!("src_{sources}");
            let record = SourceRecord {
                name: relation.clone(),
                location,
                reader: Reader::Postgres { connection },
                fingerprint: None,
            };
            approve(s, record, label, params)
        }
        Job::Run(graph) => {
            *generation += 1;
            let states = pollster::block_on(run_graph(&*engine, &graph, *generation));
            if *generation > 1 {
                pollster::block_on(drop_generation(&*engine, *generation - 1));
            }
            Reply::Compiled {
                generation: *generation,
                states,
            }
        }
        Job::Rows { key, sql } => Reply::Rows {
            key,
            rows: pollster::block_on(engine.query(&sql)),
        },
        Job::Columns { key, graph, node, port } => Reply::Rows {
            key,
            rows: pollster::block_on(geomarmot_core::graph::output_columns(&*engine, &graph, node, port)),
        },
        Job::Read { view, crs, offset } => Reply::Read {
            table: pollster::block_on(super::read(&*engine, &view, &crs, offset)),
            view,
        },
        Job::Export { view, to } => Reply::Status(match export(&*engine, staging, &view, &to) {
            Ok(()) => format!("Exported to {}", to.display()),
            Err(e) => format!("Export failed: {e}"),
        }),
        Job::Exec(sql) => Reply::Status(match pollster::block_on(engine.exec(&sql)) {
            Ok(()) => "Done.".into(),
            Err(e) => e,
        }),
        Job::OpenBytes { name, .. } => Reply::Status(format!("{name}: open files from disk on the desktop")),
    }
}

/// The CRS a source found (database tables and rasters keep it as their table's comment).
fn source_crs(s: &Supervisor, relation: &str) -> Option<String> {
    let (_, engine) = s.engine();
    let sql = format!(
        "SELECT comment FROM duckdb_tables() WHERE table_name = {}",
        qlit(relation)
    );
    pollster::block_on(engine.query(&sql))
        .ok()?
        .first()?
        .first()?
        .as_str()
        .map(String::from)
        .filter(|c| !c.is_empty())
}

/// Approve `record` (the engine restarts with it on its allow list) and report how it went.
fn approve(s: &Supervisor, record: SourceRecord, label: String, params: Value) -> Reply {
    let relation = record.name.clone();
    let failed = match s.approve_source(record) {
        Ok(states) => match states.into_iter().find(|(n, _)| *n == relation) {
            Some((_, SourceState::Ready)) => {
                let mut params = params;
                if let Some(crs) = source_crs(s, &relation) {
                    params["crs"] = crs.into();
                }
                return Reply::Opened {
                    relation,
                    label,
                    params,
                };
            }
            Some((_, SourceState::Missing(why))) => why,
            state => format!("{state:?}"),
        },
        Err(e) => e,
    };
    // A source that did not open is not tried again at every restart.
    s.forget_source(&relation);
    Reply::Status(format!("Could not open {label}: {failed}"))
}

/// Write into staging (the only place the engine may write), then move the file into place.
fn export(engine: &impl SqlEngine, staging: &Path, view: &str, to: &Path) -> Result<(), String> {
    let ext = to
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("parquet")
        .to_lowercase();
    let staged = staging.join(format!("export.{ext}"));
    let staged_text = staged.to_string_lossy().into_owned();
    match ext.as_str() {
        "parquet" => pollster::block_on(engine.exec(&format!(
            "COPY (SELECT * FROM {view}) TO {} (FORMAT PARQUET)",
            qlit(&staged_text)
        )))?,
        "csv" => pollster::block_on(engine.exec(&format!(
            "COPY (SELECT * FROM {view}) TO {} (HEADER)",
            qlit(&staged_text)
        )))?,
        "gpkg" | "geojson" | "fgb" => {
            let described = pollster::block_on(engine.describe(view))?;
            let cols: Vec<String> = described
                .iter()
                .map(|c| {
                    if c.kind.starts_with("GEOMETRY") {
                        format!("ST_AsWKB({}) AS geometry", qid(&c.name))
                    } else {
                        qid(&c.name)
                    }
                })
                .collect();
            let batches = pollster::block_on(engine.query_arrow(&format!("SELECT {} FROM {view}", cols.join(", "))))?;
            let schema = batches.first().map(|b| b.schema()).ok_or("nothing to export")?;
            geomarmot_io::write_vector(&schema, &batches, "layer", &staged_text)?;
        }
        other => return Err(format!("cannot export .{other}")),
    }
    let approvals = Approvals {
        sources: vec![],
        staging_dir: Some(staging.to_path_buf()),
    };
    finalize_export(&approvals, &staged, to)
}
