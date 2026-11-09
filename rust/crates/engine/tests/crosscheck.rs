//! Spike follow-up: the Rust comparator against `tests/harness/compare.js`. Every port the gate-1
//! fixtures produce is recorded with its expectation, unchanged and in three broken forms (a row
//! missing, a geometry moved by 1e-3, a value changed); the Rust verdicts go to
//! `rust/target/crosscheck.json`, and `rust/crates/conformance/crosscheck.mjs` replays them through
//! compare.js and fails on any disagreement.

mod support;

use geomarmot_conformance::compare::{GeomOpts, Table, compare_table};
use geomarmot_conformance::runner::{run_case_recording, teardown};
use geomarmot_engine::{Config, Host};
use serde_json::{Value, json};

/// The broken forms of an actual table, each with a label.
fn mutations(t: &Table) -> Vec<(&'static str, Table)> {
    let mut out = Vec::new();
    if !t.rows.is_empty() {
        let mut m = t.clone();
        m.rows.pop();
        out.push(("row missing", m));
    }
    let geo = t.columns.iter().position(|(_, k)| k == "GEOMETRY");
    if let Some((r, c)) = geo.and_then(|c| t.rows.iter().position(|row| row[c].is_string()).map(|r| (r, c))) {
        let mut m = t.clone();
        let wkt = m.rows[r][c].as_str().unwrap().to_string();
        // Move every occurrence of the first coordinate value by 1e-3, so rings stay closed.
        if let Some(at) = wkt.find(|ch: char| ch.is_ascii_digit() || ch == '-') {
            let end = at + wkt[at..].find([' ', ')', ',']).unwrap_or(0);
            let token = &wkt[at..end];
            if let Ok(x) = token.parse::<f64>() {
                let moved = wkt.replace(&format!("{token} "), &format!("{} ", x + 1e-3));
                m.rows[r][c] = Value::from(moved);
                out.push(("geometry moved", m));
            }
        }
    }
    let plain = t
        .columns
        .iter()
        .position(|(_, k)| k == "VARCHAR" || k == "INTEGER" || k == "DOUBLE" || k == "BIGINT");
    if let Some((r, c)) = plain.and_then(|c| t.rows.iter().position(|row| !row[c].is_null()).map(|r| (r, c))) {
        let mut m = t.clone();
        m.rows[r][c] = match &m.rows[r][c] {
            Value::String(s) => Value::from(format!("{s}_x")),
            Value::Number(n) => Value::from(n.as_f64().unwrap_or(0.0) + 1.0),
            other => other.clone(),
        };
        out.push(("value changed", m));
    }
    out
}

#[test]
fn record_comparator_verdicts() {
    let host = Host::open(&Config {
        extension_dir: support::extension_dir(),
        ..Config::default()
    })
    .unwrap();
    let mut records = Vec::new();
    for (_, text) in support::fixture_docs() {
        let doc: Value = serde_json::from_str(&text).unwrap();
        let id = doc["transformer"].as_str().unwrap();
        for case in doc["cases"].as_array().unwrap() {
            let mut ports = Vec::new();
            pollster::block_on(run_case_recording(&host, id, case, &mut ports));
            pollster::block_on(teardown(&host));
            let opts = GeomOpts::from_case(case.get("geometry"));
            let ordered = case.get("ordered").and_then(Value::as_bool).unwrap_or(false);
            for (port, actual) in ports {
                let expected = case["expect"][&port].clone();
                let want = Table::from_json(&expected);
                let mut variants = vec![("as produced", actual.clone())];
                variants.extend(mutations(&actual));
                for (label, table) in variants {
                    let problems = compare_table(&table, &want, ordered, &opts);
                    records.push(json!({
                        "case": format!("{id} › {} › {port} › {label}", case["name"].as_str().unwrap_or("?")),
                        "actual": table.to_json(),
                        "expected": expected,
                        "ordered": ordered,
                        "geometry": case.get("geometry").cloned().unwrap_or(json!({})),
                        "rustOk": problems.is_empty(),
                    }));
                }
            }
        }
    }
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/crosscheck.json");
    std::fs::write(&out, serde_json::to_string(&records).unwrap()).unwrap();
    eprintln!("recorded {} verdicts in {}", records.len(), out.display());
}
