//! A PostGIS table through the real window, headless: a saved connection (details in a file,
//! password in a vault), a Reader added for one of its tables, rows in the table and the
//! table's CRS on the Reader. Skipped unless `GEOMARMOT_TEST_PG` is `host:port:user:database`
//! (password in `GEOMARMOT_TEST_PG_PASSWORD`). Needs `cargo build --release -p geomarmot-engine`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use egui_kittest::Harness;
use geomarmot_app::app::App;
use geomarmot_app::worker::Worker;
use geomarmot_connections::{Connection, MemoryVault, Store};
use geomarmot_engine::Config;
use geomarmot_engine::supervisor::Supervisor;
use geomarmot_sql::pg::{PgServer, SslMode};

fn target() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target")
}

#[test]
fn a_postgis_table_opens_from_a_saved_connection() {
    let Some(spec) = std::env::var("GEOMARMOT_TEST_PG").ok().filter(|s| !s.is_empty()) else {
        return eprintln!("skipped: GEOMARMOT_TEST_PG is not set");
    };
    let [host, port, user, database] = spec.split(':').collect::<Vec<_>>()[..] else {
        panic!("GEOMARMOT_TEST_PG is host:port:user:database");
    };
    let password = std::env::var("GEOMARMOT_TEST_PG_PASSWORD").unwrap_or_default();
    let server = PgServer {
        host: host.into(),
        port: port.parse().unwrap(),
        database: database.into(),
        user: user.into(),
        sslmode: SslMode::Disable,
    };
    geomarmot_io::postgres::connect(&server, &password)
        .unwrap()
        .batch_execute(
            "CREATE EXTENSION IF NOT EXISTS postgis;
             DROP SCHEMA IF EXISTS gm_app_test CASCADE;
             CREATE SCHEMA gm_app_test;
             CREATE TABLE gm_app_test.sites AS
                  SELECT i AS id, 'site ' || i AS name, ST_SetSRID(ST_Point(2600000 + i, 1200000), 2056) AS geom
                    FROM generate_series(1, 3) i;",
        )
        .unwrap();

    let dir = std::env::temp_dir().join(format!("gm-app-db-{}", std::process::id()));
    let store = Arc::new(Store::new(
        &dir.join("connections.json"),
        Arc::new(MemoryVault::default()),
    ));
    store
        .save(
            &Connection {
                name: "test-db".into(),
                server,
            },
            Some(&password),
        )
        .unwrap();

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
    let lookup = store.clone();
    supervisor.set_credentials(Arc::new(move |name: &str| lookup.password(name)));
    let mut h = Harness::builder()
        .with_size(egui::vec2(1280.0, 800.0))
        .build_eframe(|_cc| App::new(Worker::start(supervisor, staging, || {})));
    h.state_mut().connections = Some(store);

    assert!(!h.state_mut().open_table("nope", "gm_app_test", "sites"));
    assert!(
        h.state().status().contains("no saved database connection"),
        "{}",
        h.state().status()
    );

    assert!(h.state_mut().open_table("test-db", "gm_app_test", "sites"));
    let t0 = Instant::now();
    while !(h.state().snarl.node_ids().count() == 1 && h.state().status() == "Ready.") {
        assert!(t0.elapsed() < Duration::from_secs(60), "status: {}", h.state().status());
        h.step();
        std::thread::sleep(Duration::from_millis(20));
    }
    let (_, reader) = h.state().snarl.node_ids().next().unwrap();
    let params = reader.node.params.clone();
    assert_eq!(params["connection"], "test-db");
    assert_eq!(params["crs"], "EPSG:2056");
    assert!(!params.to_string().contains(&password) || password.is_empty());
    let t0 = Instant::now();
    while h.state().shown_rows() != Some(3) {
        assert!(
            t0.elapsed() < Duration::from_secs(30),
            "rows: {:?}",
            h.state().shown_rows()
        );
        h.step();
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = std::fs::remove_dir_all(dir);
}
