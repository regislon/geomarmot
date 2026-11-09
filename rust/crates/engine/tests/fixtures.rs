//! Spike gate 1: `transformers/<id>/tests.json` on every native engine implementation —
//! the in-process host and the engine process — with the harness's rules
//! (`support/runner.rs`). The DuckDB-Wasm run lives with the web build.

mod support;

use geomarmot_engine::process::ProcessEngine;
use geomarmot_engine::{Host, SqlEngine};
use serde_json::Value;
use support::compare::{GeomOpts, Table, compare_table};
use support::runner::{cases, extension_dir, run_case, teardown};

/// Transformer folders covered by gate 1.
const GATE_1: &[&str] = &[
    "attribute-filter",
    "feature-joiner",
    "dissolver",
    "reprojector",
    "bufferer",
];

async fn run_all(engine: &impl SqlEngine, label: &str) {
    let mut failures = Vec::new();
    let mut passed = 0;
    for folder in GATE_1 {
        for (id, case) in cases(folder) {
            let problems = run_case(engine, &id, &case).await;
            teardown(engine).await;
            if problems.is_empty() {
                passed += 1;
            } else {
                let name = case["name"].as_str().unwrap_or("?");
                failures.push(format!("{id} › {name}\n  {}", problems.join("\n  ")));
            }
        }
    }
    eprintln!("gate 1, {label}: {passed} passed, {} failed", failures.len());
    assert!(failures.is_empty(), "\n{}", failures.join("\n\n"));
}

#[test]
fn gate_1_in_process() {
    let host = Host::open(&extension_dir()).expect("engine");
    pollster::block_on(run_all(&host, "in-process"));
}

#[test]
fn gate_1_engine_process() {
    let binary = std::path::Path::new(env!("CARGO_BIN_EXE_geomarmot-engine"));
    let engine = ProcessEngine::spawn(binary, &extension_dir()).expect("engine process");
    pollster::block_on(run_all(&engine, "engine process"));
}

/// The comparator must fail on wrong output, or a green gate means nothing.
#[test]
fn comparator_rejects_wrong_output() {
    let exact = GeomOpts::from_case(None);
    let topo = GeomOpts::from_case(Some(
        &serde_json::json!({"mode": "topology", "tolerance": 1e-7, "areaTolerance": 1e-7}),
    ));
    let cmp = support::compare::compare_geometry;
    let sq = |s: f64| format!("POLYGON ((0 0, {s} 0, {s} {s}, 0 {s}, 0 0))");
    assert!(cmp(Some("POINT (1 2)"), Some("POINT (1 2)"), &exact).is_none());
    assert!(cmp(Some("POINT (1 2.001)"), Some("POINT (1 2)"), &exact).is_some());
    assert!(cmp(Some("POINT Z (1 2 3)"), Some("POINT (1 2)"), &exact).is_some());
    assert!(
        cmp(Some(&sq(1.0)), Some("POLYGON ((1 0, 1 1, 0 1, 0 0, 1 0))"), &exact).is_some(),
        "ring start"
    );
    assert!(cmp(Some(&sq(1.0)), Some("POLYGON ((1 0, 1 1, 0 1, 0 0, 1 0))"), &topo).is_none());
    assert!(cmp(Some(&sq(1.0)), Some(&sq(1.001)), &topo).is_some(), "area");
    let t = |rows: Value| {
        Table::from_json(&serde_json::json!({"columns": [{"name": "id", "type": "INTEGER"}], "rows": rows}))
    };
    assert!(
        compare_table(
            &t(serde_json::json!([[1], [2]])),
            &t(serde_json::json!([[2], [1]])),
            false,
            &exact
        )
        .is_empty()
    );
    assert!(
        !compare_table(
            &t(serde_json::json!([[1], [2]])),
            &t(serde_json::json!([[2], [1]])),
            true,
            &exact
        )
        .is_empty()
    );
    assert!(
        !compare_table(
            &t(serde_json::json!([[1]])),
            &t(serde_json::json!([[1], [1]])),
            false,
            &exact
        )
        .is_empty()
    );
}
