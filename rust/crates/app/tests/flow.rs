//! Spike gate 5, desktop: one usable flow driven through the real window, headless —
//! open a file, chain Bufferer → Dissolver, read the table, export, and render a screenshot
//! to `rust/target/gate5-flow.png`. Needs the engine binary built first:
//! `cargo build --release -p geomarmot-engine`.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use egui_kittest::Harness;
use egui_snarl::{InPinId, NodeId, OutPinId};
use geomarmot_app::app::App;
use geomarmot_app::canvas::NodeData;
use geomarmot_app::worker::Worker;
use geomarmot_engine::Config;
use geomarmot_engine::supervisor::Supervisor;
use serde_json::json;

fn target() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target")
}

fn wait(h: &mut Harness<'_, App>, what: &str, done: impl Fn(&App) -> bool) {
    let t0 = Instant::now();
    while !done(h.state()) {
        assert!(
            t0.elapsed() < Duration::from_secs(60),
            "timed out waiting for {what}; status: {}",
            h.state().status()
        );
        h.step();
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn open_chain_read_export() {
    let extensions = target().join("duckdb-extensions");
    if !extensions.exists() {
        geomarmot_engine::install_extensions(&extensions).unwrap();
    }
    let staging = std::env::temp_dir().join(format!("gm-flow-{}", std::process::id()));
    let config = Config {
        extension_dir: extensions,
        staging_dir: Some(staging.clone()),
        ..Config::default()
    };
    let supervisor = Supervisor::start(&target().join("release/geomarmot-engine"), config, false).unwrap();
    let mut h = Harness::builder()
        .with_size(egui::vec2(1280.0, 800.0))
        .wgpu()
        .build_eframe(|_cc| App::new(Worker::start(supervisor, staging, || {})));

    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/generated/areas.geojson");
    h.state_mut().open(file);
    wait(&mut h, "the Reader", |a| {
        a.snarl.node_ids().count() == 1 && a.status() == "Ready."
    });

    let app = h.state_mut();
    let reader = NodeId(0);
    let buffer = app.snarl.insert_node(
        egui::pos2(320.0, 40.0),
        NodeData::new("Bufferer", json!({"distance": "200"}), String::new()),
    );
    let dissolve = app.snarl.insert_node(
        egui::pos2(600.0, 40.0),
        NodeData::new("Dissolver", json!({"groupBy": []}), String::new()),
    );
    app.snarl.connect(
        OutPinId {
            node: reader,
            output: 0,
        },
        InPinId { node: buffer, input: 0 },
    );
    app.snarl.connect(
        OutPinId {
            node: buffer,
            output: 0,
        },
        InPinId {
            node: dissolve,
            input: 0,
        },
    );
    app.viewer.selected = Some((buffer.0, 0));
    app.viewer.changed = true;
    wait(&mut h, "the table", |a| a.shown_rows().is_some_and(|n| n > 0));

    let out = std::env::temp_dir().join(format!("gm-flow-{}.parquet", std::process::id()));
    h.state_mut().export(out.clone());
    wait(&mut h, "the export", |a| a.status().starts_with("Export"));
    assert!(h.state().status().starts_with("Exported"), "{}", h.state().status());
    assert!(out.exists());

    h.run_steps(3);
    let image = h.render().expect("render");
    image.save(target().join("gate5-flow.png")).unwrap();
    h.state_mut().tab_map = true;
    h.run_steps(3);
    h.render()
        .expect("render")
        .save(target().join("gate5-map.png"))
        .unwrap();
}
