//! Running one fixture case on any engine, the way `tests/harness/run-case.js` does:
//! inputs become typed tables, the subject node is compiled, every port is read with
//! the harness's `readPort` rules and compared (`compare.rs`, a port of `compare.js`).

use std::collections::BTreeMap;

use geomarmot_core::{LONLAT, SqlEngine, compile_node, qid, qlit, transformers};
use serde_json::Value;

use crate::compare::{GeomOpts, Table, compare_table};

/// The harness's `typedLiteral`.
fn literal(value: &Value, kind: &str) -> String {
    match value {
        Value::Null => format!("NULL::{kind}"),
        _ if kind == "GEOMETRY" => format!("ST_GeomFromText({})", qlit(value.as_str().unwrap_or_default())),
        Value::String(s) => format!("CAST({} AS {kind})", qlit(s)),
        other => format!("CAST({} AS {kind})", qlit(&other.to_string())),
    }
}

pub async fn create_table(engine: &impl SqlEngine, name: &str, input: &Value) -> Result<(), String> {
    let table = Table::from_json(input);
    let defs: Vec<String> = table.columns.iter().map(|(n, k)| format!("{} {k}", qid(n))).collect();
    engine
        .exec(&format!("CREATE OR REPLACE TABLE {} ({})", qid(name), defs.join(", ")))
        .await?;
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
    engine
        .exec(&format!("INSERT INTO {} VALUES {}", qid(name), rows.join(", ")))
        .await
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

pub async fn read_port(engine: &impl SqlEngine, view: &str) -> Result<Table, String> {
    let columns: Vec<(String, String)> = engine
        .describe(view)
        .await?
        .into_iter()
        .map(|c| (c.name, c.kind))
        .collect();
    if columns.is_empty() {
        return Ok(Table { columns, rows: vec![] });
    }
    let selection: Vec<String> = columns.iter().map(|(n, k)| readable(n, k)).collect();
    let rows = engine
        .query(&format!("SELECT {} FROM {view}", selection.join(", ")))
        .await?;
    Ok(Table { columns, rows })
}

/// Run one case; returns its problems (empty = pass). Mirrors `runCase` + `checkCase`.
pub async fn run_case(engine: &impl SqlEngine, id: &str, case: &Value) -> Vec<String> {
    let Some(t) = transformers::by_id(id) else {
        return vec![format!("{id} is not ported")];
    };
    let mut inputs = BTreeMap::new();
    for (k, (port, input)) in case["inputs"].as_object().into_iter().flatten().enumerate() {
        let table = format!("fx_{k}");
        if let Err(e) = create_table(engine, &table, input).await {
            return vec![format!("could not build input {port}: {e}")];
        }
        let crs = input.get("crs").and_then(Value::as_str).unwrap_or(LONLAT);
        inputs.insert(port.clone(), (qid(&table), crs.to_string()));
    }
    let params = case.get("params").cloned().unwrap_or(Value::Object(Default::default()));
    let compiled = compile_node(engine, t, &params, &inputs, "subject").await;
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
        match read_port(engine, view).await {
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

/// Clear what a case left behind, as the harness's teardown does.
pub async fn teardown(engine: &impl SqlEngine) {
    for (name, kind) in engine
        .query("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'main'")
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|r| Some((r[0].as_str()?.to_string(), r[1].as_str()?.to_string())))
    {
        let what = if kind == "VIEW" { "VIEW" } else { "TABLE" };
        let _ = engine.exec(&format!("DROP {what} IF EXISTS {}", qid(&name))).await;
    }
}
