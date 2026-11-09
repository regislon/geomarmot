//! Runs `transformers/<id>/tests.json` on the native engine, the way
//! `tests/harness/run-case.js` runs them on DuckDB-Wasm: inputs become typed tables,
//! the subject node is compiled, every port is read with the harness's readPort
//! rules and compared with `support::compare` (a port of `tests/harness/compare.js`).
//!
//! Spike gate 1. Extensions are installed once into `rust/target/duckdb-extensions`.

mod support;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use geomarmot_core::{Engine, LONLAT, compile_node, qid, qlit, transformers};
use serde_json::Value;
use support::compare::{GeomOpts, Table, compare_table};

/// Transformer folders covered by gate 1.
const GATE_1: &[&str] = &[
    "attribute-filter",
    "feature-joiner",
    "dissolver",
    "reprojector",
    "bufferer",
];

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn extension_dir() -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/duckdb-extensions");
    if !dir.exists() {
        geomarmot_engine::install_extensions(&dir).expect("install extensions");
    }
    dir
}

/// The harness's `typedLiteral`.
fn literal(value: &Value, kind: &str) -> String {
    match value {
        Value::Null => format!("NULL::{kind}"),
        _ if kind == "GEOMETRY" => format!("ST_GeomFromText({})", qlit(value.as_str().unwrap_or_default())),
        Value::String(s) => format!("CAST({} AS {kind})", qlit(s)),
        Value::Object(_) | Value::Array(_) => format!("CAST({} AS {kind})", qlit(&value.to_string())),
        other => format!("CAST({} AS {kind})", qlit(&other.to_string())),
    }
}

fn create_table(engine: &Engine, name: &str, input: &Value) -> Result<(), String> {
    let table = Table::from_json(input);
    let defs: Vec<String> = table.columns.iter().map(|(n, k)| format!("{} {k}", qid(n))).collect();
    engine.exec(&format!("CREATE OR REPLACE TABLE {} ({})", qid(name), defs.join(", ")))?;
    if table.rows.is_empty() {
        return Ok(());
    }
    let rows: Vec<String> = table
        .rows
        .iter()
        .map(|r| {
            let cells: Vec<String> = r.iter().zip(&table.columns).map(|(v, (_, k))| literal(v, k)).collect();
            format!("({})", cells.join(", "))
        })
        .collect();
    engine.exec(&format!("INSERT INTO {} VALUES {}", qid(name), rows.join(", ")))
}

/// The harness's `readableColumn`.
fn readable(name: &str, kind: &str) -> String {
    let n = qid(name);
    let starts = |p: &[&str]| p.iter().any(|x| kind.starts_with(x));
    match kind {
        "GEOMETRY" => format!("ST_AsText({n}) AS {n}"),
        "WKB_BLOB" => format!("ST_AsText(ST_GeomFromWKB({n})) AS {n}"),
        "BLOB" => format!("hex({n}) AS {n}"),
        "BIGINT" | "UBIGINT" | "HUGEINT" | "UHUGEINT" => format!("{n}::VARCHAR AS {n}"),
        _ if kind.starts_with("DECIMAL") => format!("{n}::DOUBLE AS {n}"),
        _ if starts(&["DATE", "TIME", "TIMESTAMP", "INTERVAL"]) => format!("{n}::VARCHAR AS {n}"),
        _ if kind.ends_with("[]") || starts(&["STRUCT", "MAP", "UNION"]) => format!("to_json({n})::VARCHAR AS {n}"),
        _ => n,
    }
}

fn read_port(engine: &Engine, view: &str) -> Result<Table, String> {
    let columns: Vec<(String, String)> = engine.describe(view)?.into_iter().map(|c| (c.name, c.kind)).collect();
    if columns.is_empty() {
        return Ok(Table { columns, rows: vec![] });
    }
    let selection: Vec<String> = columns.iter().map(|(n, k)| readable(n, k)).collect();
    let rows = engine.query(&format!("SELECT {} FROM {view}", selection.join(", ")))?;
    Ok(Table { columns, rows })
}

/// Run one case; returns its problems (empty = pass). Mirrors `runCase` + `checkCase`.
fn run_case(engine: &Engine, id: &str, case: &Value) -> Vec<String> {
    let Some(t) = transformers::by_id(id) else {
        return vec![format!("{id} is not ported")];
    };
    let mut inputs = BTreeMap::new();
    for (k, (port, input)) in case["inputs"].as_object().into_iter().flatten().enumerate() {
        let table = format!("fx_{k}");
        if let Err(e) = create_table(engine, &table, input) {
            return vec![format!("could not build input {port}: {e}")];
        }
        let crs = input.get("crs").and_then(Value::as_str).unwrap_or(LONLAT);
        inputs.insert(port.clone(), (qid(&table), crs.to_string()));
    }
    let params = case.get("params").cloned().unwrap_or(Value::Object(Default::default()));
    let compiled = compile_node(engine, t, &params, &inputs, "subject");
    let expect = &case["expect"];

    if let Some(want) = expect.get("error").and_then(Value::as_str) {
        return match compiled {
            Ok(_) => vec![format!("expected an error containing \"{want}\", got none")],
            Err(e) if e.contains(want) => vec![],
            Err(e) => vec![format!("error \"{e}\" does not contain \"{want}\"")],
        };
    }
    let out = match compiled {
        Ok(out) => out,
        Err(e) => return vec![format!("unexpected error: {e}")],
    };
    let opts = GeomOpts::from_case(case.get("geometry"));
    let ordered = case.get("ordered").and_then(Value::as_bool).unwrap_or(false);
    let mut problems = Vec::new();
    for (port, expected) in expect.as_object().into_iter().flatten().filter(|(p, _)| *p != "crs") {
        let Some(view) = out.views.get(port) else {
            let have: Vec<&str> = out.views.keys().map(String::as_str).collect();
            problems.push(format!("no \"{port}\" port in the output (have: {})", have.join(", ")));
            continue;
        };
        match read_port(engine, view) {
            Ok(actual) => problems.extend(
                compare_table(&actual, &Table::from_json(expected), ordered, &opts)
                    .into_iter()
                    .map(|p| format!("{port}: {p}")),
            ),
            Err(e) => problems.push(format!("{port}: could not read: {e}")),
        }
    }
    if let Some(want) = expect.get("crs").and_then(Value::as_str)
        && want != out.crs
    {
        problems.push(format!("output CRS {}, expected {want}", out.crs));
    }
    problems
}

#[test]
fn gate_1_fixtures() {
    let dir = extension_dir();
    let mut failures = Vec::new();
    let mut passed = 0;
    for folder in GATE_1 {
        let path = repo().join("transformers").join(folder).join("tests.json");
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let id = doc["transformer"].as_str().unwrap();
        for case in doc["cases"].as_array().unwrap() {
            // A fresh engine per case, as the harness tears down between cases.
            let engine = Engine::open(&dir).expect("engine");
            let problems = run_case(&engine, id, case);
            if problems.is_empty() {
                passed += 1;
            } else {
                failures.push(format!(
                    "{id} › {}\n  {}",
                    case["name"].as_str().unwrap_or("?"),
                    problems.join("\n  ")
                ));
            }
        }
    }
    eprintln!("gate 1: {passed} passed, {} failed", failures.len());
    assert!(failures.is_empty(), "\n{}", failures.join("\n\n"));
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
