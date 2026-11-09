//! Desktop: the engine process, driven from a background thread so the UI never waits on it.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};

use geomarmot_core::graph::{drop_generation, run_graph};
use geomarmot_core::{SqlEngine, qid, qlit};

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
            match s.approve_source(record) {
                Ok(states) if states.iter().any(|(n, st)| *n == relation && *st != SourceState::Ready) => {
                    let state = states.into_iter().find(|(n, _)| *n == relation).map(|(_, st)| st);
                    Reply::Status(format!("Could not open {}: {state:?}", path.display()))
                }
                Ok(_) => Reply::Opened {
                    relation,
                    label: path.file_name().unwrap_or_default().to_string_lossy().into(),
                },
                Err(e) => Reply::Status(format!("Could not open {}: {e}", path.display())),
            }
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
