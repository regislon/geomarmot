//! GeoMarmot desktop. The engine runs in its own process (`geomarmot-engine`, next to this
//! binary); extensions come from `duckdb-extensions` next to it, or `GEOMARMOT_EXTENSIONS`.

use std::path::PathBuf;

use geomarmot_app::{app, worker};
use geomarmot_engine::Config;
use geomarmot_engine::supervisor::Supervisor;

#[cfg(not(target_arch = "wasm32"))]
fn beside_exe(name: &str) -> PathBuf {
    std::env::current_exe()
        .map(|p| p.with_file_name(name))
        .unwrap_or_else(|_| name.into())
}

#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
fn main() -> eframe::Result {
    let started = std::time::Instant::now();
    let extension_dir = std::env::var_os("GEOMARMOT_EXTENSIONS")
        .map(PathBuf::from)
        .unwrap_or_else(|| beside_exe("duckdb-extensions"));
    let staging = std::env::temp_dir().join(format!("geomarmot-{}", std::process::id()));
    let config = Config {
        extension_dir,
        staging_dir: Some(staging.clone()),
        memory_limit: None,
        allowed_paths: vec![],
    };
    let supervisor = match Supervisor::start(&beside_exe("geomarmot-engine"), config, false) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Could not start the engine: {e}");
            std::process::exit(1);
        }
    };
    eframe::run_native(
        "GeoMarmot",
        eframe::NativeOptions::default(),
        Box::new(move |cc| {
            let ctx = cc.egui_ctx.clone();
            let worker = worker::Worker::start(supervisor, staging, move || ctx.request_repaint());
            let mut app = app::App::new(worker);
            app.probe = geomarmot_app::probe::Probe::from_env(started);
            Ok(Box::new(app))
        }),
    )
}
