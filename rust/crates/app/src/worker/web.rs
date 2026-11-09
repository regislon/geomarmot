//! Browser: DuckDB-Wasm (in its own Web Worker, behind `rust/web/bridge.js`), driven from an
//! async task on the page. Cancel is the bridge's: cooperative first, then the DuckDB worker
//! is terminated and a fresh one booted with the sources registered again (ADR 0004).

use std::sync::mpsc::{Receiver, Sender, channel};

use futures::StreamExt;
use futures::channel::mpsc::{UnboundedSender, unbounded};
use geomarmot_core::graph::{drop_generation, run_graph};
use geomarmot_core::{SqlEngine, qid, qlit};
use geomarmot_web::{WasmEngine, bridge};

use super::{Job, Reply};

pub struct Worker {
    jobs: UnboundedSender<Job>,
    pub replies: Receiver<Reply>,
}

impl Worker {
    pub fn start(wake: impl Fn() + 'static) -> Self {
        let (jobs, mut inbox) = unbounded::<Job>();
        let (outbox, replies): (Sender<Reply>, _) = channel();
        wasm_bindgen_futures::spawn_local(async move {
            let (mut generation, mut sources) = (0u64, 0usize);
            while let Some(job) = inbox.next().await {
                let reply = run(job, &mut generation, &mut sources).await;
                if outbox.send(reply).is_err() {
                    break;
                }
                wake();
            }
        });
        Self { jobs, replies }
    }

    pub fn send(&self, job: Job) {
        let _ = self.jobs.unbounded_send(job);
    }

    /// A sender for async callbacks (the file picker).
    pub fn sender(&self) -> impl Fn(Job) + 'static {
        let jobs = self.jobs.clone();
        move |job| {
            let _ = jobs.unbounded_send(job);
        }
    }

    pub fn cancel(&self) -> String {
        wasm_bindgen_futures::spawn_local(async {
            let _ = bridge::cancel().await;
        });
        "Cancelling…".into()
    }
}

fn scan(name: &str) -> String {
    let file = qlit(&bridge::path(name));
    match name.rsplit('.').next().unwrap_or_default().to_lowercase().as_str() {
        "csv" | "tsv" => format!("read_csv({file})"),
        "parquet" | "pq" => format!("read_parquet({file})"),
        _ => format!("ST_Read({file})"),
    }
}

async fn run(job: Job, generation: &mut u64, sources: &mut usize) -> Reply {
    let engine = WasmEngine;
    match job {
        Job::OpenBytes { name, bytes } => {
            *sources += 1;
            let relation = format!("src_{sources}");
            let sql = format!(
                "CREATE OR REPLACE VIEW {} AS SELECT * FROM {}",
                qid(&relation),
                scan(&name)
            );
            match bridge::add_source(&name, &bytes, &sql).await {
                Ok(()) => Reply::Opened { relation, label: name },
                Err(e) => Reply::Status(format!("Could not open {name}: {e}")),
            }
        }
        Job::Run(graph) => {
            *generation += 1;
            let states = run_graph(&engine, &graph, *generation).await;
            if *generation > 1 {
                drop_generation(&engine, *generation - 1).await;
            }
            Reply::Compiled {
                generation: *generation,
                states,
            }
        }
        Job::Rows { key, sql } => Reply::Rows {
            key,
            rows: engine.query(&sql).await,
        },
        Job::Read { view, crs, offset } => Reply::Read {
            table: super::read(&engine, &view, &crs, offset).await,
            view,
        },
        Job::Export { view, to } => {
            let name = to
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or("export.parquet".into());
            let format = if name.ends_with(".csv") {
                "(HEADER)"
            } else {
                "(FORMAT PARQUET)"
            };
            let copy = format!("COPY (SELECT * FROM {view}) TO {} {format}", qlit(&bridge::path(&name)));
            Reply::Status(match bridge::download(&copy, &name).await {
                Ok(()) => format!("Exported {name}"),
                Err(e) => format!("Export failed: {e}"),
            })
        }
        Job::Exec(sql) => Reply::Status(match geomarmot_core::SqlEngine::exec(&engine, &sql).await {
            Ok(()) => "Done.".into(),
            Err(e) => e,
        }),
        Job::Open(path) => Reply::Status(format!("{}: pick files with the Open button", path.display())),
    }
}
