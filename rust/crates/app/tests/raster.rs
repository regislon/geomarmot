//! A GeoTIFF through the real window, headless: opening it adds a Reader whose output is the
//! raster's footprint (in the raster's CRS), and RasterToPolygonCoercer turns it into areas shown
//! in the table. Needs `cargo build --release -p geomarmot-engine`.

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
fn a_geotiff_opens_as_a_raster_and_becomes_areas() {
    let dir = std::env::temp_dir().join(format!("gm-app-raster-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let tif = dir.join("classes.tif");
    let values = vec![1.0, 1.0, 2.0, 2.0, 1.0, 1.0, 2.0, 2.0, 1.0, -9999.0, 2.0, 2.0];
    let t = [2_600_000.0, 10.0, 0.0, 1_200_000.0, 0.0, -10.0];
    geomarmot_io::raster::write_f32(&tif.to_string_lossy(), values, (4, 3), t, Some(2056), -9999.0, true).unwrap();

    let extensions = target().join("duckdb-extensions");
    if !extensions.exists() {
        geomarmot_engine::install_extensions(&extensions).unwrap();
    }
    let staging = dir.join("staging");
    let config = Config {
        extension_dir: extensions,
        staging_dir: Some(staging.clone()),
        ..Config::default()
    };
    let supervisor = Supervisor::start(&target().join("release/geomarmot-engine"), config, false).unwrap();
    let mut h = Harness::builder()
        .with_size(egui::vec2(1280.0, 800.0))
        .build_eframe(|_cc| App::new(Worker::start(supervisor, staging, || {})));

    h.state_mut().open(tif);
    wait(&mut h, "the Reader", |a| {
        a.snarl.node_ids().count() == 1 && a.status() == "Ready."
    });
    let reader = NodeId(0);
    assert_eq!(h.state().snarl[reader].node.params["crs"], "EPSG:2056");
    wait(&mut h, "the footprint row", |a| a.shown_rows() == Some(1));

    let app = h.state_mut();
    let areas = app.snarl.insert_node(
        egui::pos2(640.0, 80.0),
        NodeData::new("RasterToPolygonCoercer", json!({ "band": "1" }), String::new()),
    );
    app.snarl.connect(
        OutPinId {
            node: reader,
            output: 0,
        },
        InPinId { node: areas, input: 0 },
    );
    app.viewer.selected = Some((areas.0, 0));
    app.run(None);
    wait(&mut h, "two areas", |a| a.shown_rows() == Some(2));
    let _ = std::fs::remove_dir_all(dir);
}
