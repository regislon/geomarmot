//! Running one fixture case on any engine, the way `tests/harness/run-case.js` does:
//! inputs become typed tables, the subject node is compiled, every port is read with
//! the harness's `readPort` rules and compared (`compare.rs`, a port of `compare.js`).

use std::collections::BTreeMap;

use geomarmot_core::{LONLAT, SqlEngine, compile_node_from, h3, qid, qlit, transformers};
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

/// A case's `source` as the Reader of a Parquet file presents it: its rows, plus `file_row_number`
/// when the Reader's Row number is Yes, or Auto on a dense positional H3 tile (`rowNumberWanted`).
fn reader_table(source: &Value, file_name: &str) -> Value {
    let mut table = source.clone();
    let rows = source["rows"].as_array().cloned().unwrap_or_default();
    let positional =
        h3::parse_parent_cell(file_name).is_some_and(|p| h3::child_resolution_for(&p, rows.len() as u64).is_some());
    let wanted = match source["readerParams"]["rowNumber"].as_str().unwrap_or("Auto") {
        "Yes" => true,
        "No" => false,
        _ => positional,
    };
    if wanted {
        if let Some(columns) = table["columns"].as_array_mut() {
            columns.push(serde_json::json!({ "name": h3::ROW_NUMBER_COLUMN, "type": "BIGINT" }));
        }
        table["rows"] = rows
            .into_iter()
            .enumerate()
            .map(|(i, mut r)| {
                if let Some(cells) = r.as_array_mut() {
                    cells.push(i.into());
                }
                r
            })
            .collect();
    }
    table
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
    run_case_recording(engine, id, case, &mut Vec::new()).await
}

/// As `run_case`, also recording every port read: (port, actual table) — for cross-checking
/// this comparator against `tests/harness/compare.js`.
pub async fn run_case_recording(
    engine: &impl SqlEngine,
    id: &str,
    case: &Value,
    record: &mut Vec<(String, Table)>,
) -> Vec<String> {
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
    let file_name = case["source"]["fileName"].as_str().map(String::from);
    if let Some(name) = &file_name {
        let table = reader_table(&case["source"], name);
        if let Err(e) = create_table(engine, "fx_src", &table).await {
            return vec![format!("could not build the source: {e}")];
        }
        inputs.insert("input".into(), (qid("fx_src"), LONLAT.to_string()));
    }
    let params = case.get("params").cloned().unwrap_or(Value::Object(Default::default()));
    let compiled = compile_node_from(engine, t, &params, &inputs, "subject", file_name).await;
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
    if let Some(a) = case.get("assert") {
        let port = a["port"].as_str().unwrap_or("output");
        let Some(view) = out.views.get(port) else {
            return vec![format!("no \"{port}\" port")];
        };
        return match read_port(engine, view).await {
            Ok(table) => check_assertions(&table, a, case["inputs"].get("input")),
            Err(e) => vec![format!("{port}: could not read: {e}")],
        };
    }
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
                {
                    let found = compare_table(&actual, &Table::from_json(expected), ordered, &opts);
                    record.push((port.clone(), actual));
                    found
                }
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

/// Invariants for cases whose rows cannot be predicted exactly (`checkAssertions`).
fn check_assertions(table: &Table, a: &Value, input: Option<&Value>) -> Vec<String> {
    let mut problems = Vec::new();
    let input = input.map(Table::from_json);
    if let Some(count) = a.get("rowCount") {
        let n = table.rows.len() as f64;
        let (min, max) = (count["min"].as_f64(), count["max"].as_f64());
        if min.is_some_and(|m| m > n) || max.is_some_and(|m| m < n) {
            problems.push(format!(
                "{n} rows, expected between {} and {}",
                count["min"], count["max"]
            ));
        }
    }
    if let Some(input) = input.as_ref().filter(|_| a["columnsEqual"] == "input")
        && table.columns != input.columns
    {
        problems.push(format!("columns {:?} ≠ input's {:?}", table.columns, input.columns));
    }
    if let Some(input) = input.as_ref().filter(|_| a["subsetOf"] == "input") {
        let mut pool: Vec<String> = input.rows.iter().map(|r| Value::from(r.clone()).to_string()).collect();
        for row in &table.rows {
            let key = Value::from(row.clone()).to_string();
            match pool.iter().position(|p| *p == key) {
                Some(at) => {
                    pool.remove(at);
                }
                None => problems.push(format!("row {key} is not an input row")),
            }
        }
    }
    if let Some(names) = a["unique"].as_array() {
        let idx: Vec<Option<usize>> = names
            .iter()
            .map(|n| table.columns.iter().position(|(c, _)| Some(c.as_str()) == n.as_str()))
            .collect();
        let keys: std::collections::HashSet<String> = table
            .rows
            .iter()
            .map(|r| format!("{:?}", idx.iter().map(|k| k.map(|k| &r[k])).collect::<Vec<_>>()))
            .collect();
        if keys.len() != table.rows.len() {
            problems.push(format!("rows are not unique on {names:?}"));
        }
    }
    problems
}
