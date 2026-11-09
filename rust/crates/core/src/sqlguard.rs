//! The SQL guard (docs/security.md): the one check every untrusted fragment goes
//! through before DuckDB sees it. Port of `app/src/core/sqlguard/`.
//!
//! The guard's only contact with the engine is parsing: the placeholder form is
//! passed to `json_serialize_sql()` as a quoted literal. Parsing executes nothing.

use std::collections::HashSet;

use serde_json::Value;

use crate::{Kind, Param, SqlEngine, qlit};

/// Placeholder for the upstream relation in a placeholder form.
pub const INPUT_PLACEHOLDER: &str = "__gm_input";

/// Functions that read settings, the environment or files, refused even though they are scalar.
const FUNCTION_DENYLIST: &[&str] = &[
    "getenv",
    "current_setting",
    "getvariable",
    "current_database",
    "current_schema",
    "current_schemas",
    "read_text",
    "read_blob",
    "glob",
    "sniff_csv",
    "st_read",
    "st_read_meta",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Context {
    /// A whole query over `input`.
    Query,
    /// An expression evaluated per row of `input`.
    Expression,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}

/// Bind the upstream relation as `input` in front of a query (`composeSql`).
pub fn splice_query(sql: &str, upstream: &str) -> String {
    let body = sql.trim().trim_end_matches(|c: char| c == ';' || c.is_whitespace());
    let bind = format!("input AS (SELECT * FROM {upstream})");
    // ASCII lower-casing keeps byte offsets, so positions found in `lower` index `body`.
    let lower = body.to_ascii_lowercase();
    let keyword = |at: usize, word: &str| {
        lower[at..].starts_with(word) && lower[at + word.len()..].starts_with(char::is_whitespace)
    };
    let skip_ws = |at: usize| at + (lower.len() - at - lower[at..].trim_start().len());
    if keyword(0, "with") {
        let next = skip_ws(4);
        if keyword(next, "recursive") {
            return format!("WITH RECURSIVE {bind}, {}", &body[skip_ws(next + 9)..]);
        }
        return format!("WITH {bind}, {}", &body[next..]);
    }
    format!("WITH {bind} {body}")
}

/// Splice an expression; the newlines stop a trailing `--` comment swallowing the parenthesis.
pub fn splice_expression(fragment: &str) -> String {
    format!("(\n{fragment}\n)")
}

fn placeholder(fragment: &str, context: Context) -> String {
    match context {
        Context::Query => splice_query(fragment, INPUT_PLACEHOLDER),
        Context::Expression => {
            format!(
                "SELECT {} AS v FROM {INPUT_PLACEHOLDER} AS input",
                splice_expression(fragment)
            )
        }
    }
}

/// First word of a statement, past leading comments.
fn leading_verb(sql: &str) -> String {
    let mut s = sql.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--") {
            s = rest.split_once('\n').map_or("", |(_, r)| r).trim_start();
        } else if let Some(rest) = s.strip_prefix("/*") {
            s = rest.split_once("*/").map_or("", |(_, r)| r).trim_start();
        } else {
            break;
        }
    }
    s.split_whitespace().next().unwrap_or_default().to_uppercase()
}

fn refuse(code: &'static str, message: impl Into<String>) -> Refusal {
    Refusal {
        code,
        message: message.into(),
    }
}

#[derive(Default)]
struct Found {
    tables: Vec<(String, String, String)>,
    table_functions: Vec<String>,
    functions: Vec<(String, String, bool)>,
    ctes: HashSet<String>,
}

fn collect(node: &Value, found: &mut Found) {
    match node {
        Value::Array(items) => items.iter().for_each(|v| collect(v, found)),
        Value::Object(o) => {
            let s = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
            let kind = s("type");
            if kind == "BASE_TABLE" && o.get("table_name").is_some_and(Value::is_string) {
                found
                    .tables
                    .push((s("schema_name"), s("catalog_name"), s("table_name")));
            }
            if kind == "TABLE_FUNCTION" {
                let name = o
                    .get("function")
                    .and_then(|f| f.get("function_name"))
                    .and_then(Value::as_str);
                found.table_functions.push(name.unwrap_or("?").to_string());
            }
            if s("class") == "FUNCTION"
                && o.get("function_name").is_some_and(Value::is_string)
                && kind != "TABLE_FUNCTION"
            {
                let op = o.get("is_operator").and_then(Value::as_bool).unwrap_or(false);
                found
                    .functions
                    .push((s("function_name").to_lowercase(), s("schema"), op));
            }
            if let Some(map) = o.get("cte_map").and_then(|m| m.get("map")).and_then(Value::as_array) {
                for entry in map {
                    let key = entry
                        .get("key")
                        .map(|k| k.as_str().map(String::from).unwrap_or(k.to_string()));
                    found.ctes.insert(key.unwrap_or_default().to_lowercase());
                }
            }
            o.values()
                .filter(|v| v.is_object() || v.is_array())
                .for_each(|v| collect(v, found));
        }
        _ => {}
    }
}

/// Check a parsed statement against the relations it may read and the functions the engine has.
fn check(parsed: &Value, allowed: &[&str], known: &HashSet<String>) -> Vec<Refusal> {
    let statements = parsed
        .get("statements")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if statements.len() != 1 {
        return vec![refuse(
            "SQL_FORBIDDEN_CONSTRUCT",
            "One statement only — everything after the first ; would be ignored.",
        )];
    }
    let mut found = Found::default();
    collect(&statements[0], &mut found);
    let allowed: HashSet<String> = allowed.iter().map(|a| a.to_lowercase()).collect();
    let mut problems = Vec::new();
    for cte in &found.ctes {
        if allowed.contains(cte) && cte != "input" {
            problems.push(refuse(
                "SQL_FORBIDDEN_CONSTRUCT",
                format!("A CTE may not be named \"{cte}\"."),
            ));
        }
    }
    for name in &found.table_functions {
        problems.push(refuse(
            "SQL_FORBIDDEN_CONSTRUCT",
            format!("Table functions such as {name}() are not allowed here: this SQL may only read its inputs."),
        ));
    }
    for (schema, catalog, name) in &found.tables {
        let lower = name.to_lowercase();
        let foreign = !schema.is_empty() || !catalog.is_empty() || name.contains(['.', '/', '\\', ':']);
        if foreign || (!allowed.contains(&lower) && !found.ctes.contains(&lower)) {
            problems.push(refuse(
                "SQL_FORBIDDEN_CONSTRUCT",
                format!("\"{name}\" is not one of this node's inputs; read from input."),
            ));
        }
    }
    for (name, schema, is_operator) in &found.functions {
        if *is_operator {
            continue;
        }
        if FUNCTION_DENYLIST.contains(&name.as_str()) {
            problems.push(refuse(
                "SQL_FORBIDDEN_CONSTRUCT",
                format!("{name}() is not allowed here."),
            ));
        } else if !schema.is_empty() && schema != "main" {
            problems.push(refuse(
                "SQL_FORBIDDEN_CONSTRUCT",
                format!("{schema}.{name}() is not allowed here."),
            ));
        } else if !known.contains(name) {
            problems.push(refuse(
                "SQL_FORBIDDEN_CONSTRUCT",
                format!("{name}() is not a function this engine has."),
            ));
        }
    }
    problems
}

/// Validate one untrusted fragment. `Ok(())` when it may run.
pub async fn validate(engine: &impl SqlEngine, fragment: &str, context: Context) -> Result<(), Refusal> {
    let trimmed = fragment
        .trim()
        .trim_end_matches(|c: char| c == ';' || c.is_whitespace());
    if context == Context::Query {
        let verb = leading_verb(fragment);
        if !["SELECT", "WITH", "FROM", "VALUES", "TABLE"].contains(&verb.as_str()) && !verb.starts_with('(') {
            let what = if verb.is_empty() { "That".into() } else { verb };
            return Err(refuse(
                "SQL_FORBIDDEN_CONSTRUCT",
                format!("{what} is not a query. This node needs a SELECT that returns rows."),
            ));
        }
    }
    let statement = placeholder(trimmed, context);
    let known: HashSet<String> = engine
        .query(
            "SELECT DISTINCT lower(function_name) FROM duckdb_functions() \
             WHERE function_type NOT IN ('table', 'table_macro', 'pragma')",
        )
        .await
        .map_err(|e| refuse("SQL_SYNTAX", e))?
        .into_iter()
        .filter_map(|r| r[0].as_str().map(String::from))
        .collect();
    let rows = engine
        .query(&format!("SELECT json_serialize_sql({})", qlit(&statement)))
        .await
        .map_err(|e| refuse("SQL_SYNTAX", e))?;
    let tree: Value = rows
        .first()
        .and_then(|r| r[0].as_str())
        .and_then(|t| serde_json::from_str(t).ok())
        .ok_or_else(|| refuse("SQL_SYNTAX", "The SQL does not parse."))?;
    if tree.get("error").and_then(Value::as_bool).unwrap_or(false) {
        let message = tree
            .get("error_message")
            .and_then(Value::as_str)
            .unwrap_or("The SQL does not parse.");
        if message.to_lowercase().contains("only select statements") {
            let verb = leading_verb(fragment);
            return Err(refuse("SQL_FORBIDDEN_CONSTRUCT", format!("{verb} is not a query.")));
        }
        return Err(refuse("SQL_SYNTAX", message));
    }
    match check(&tree, &[INPUT_PLACEHOLDER, "input"], &known).into_iter().next() {
        Some(problem) => Err(problem),
        None => Ok(()),
    }
}

/// Every untrusted fragment in a node's params, with its context (`fragmentsOf`).
pub fn fragments(params: &[Param], values: &Value) -> Vec<(String, Context)> {
    let mut out = Vec::new();
    let mut text = |v: &Value, context| {
        if let Some(s) = v.as_str().filter(|s| !s.trim().is_empty()) {
            out.push((s.to_string(), context));
        }
    };
    let spec = |v: &Value| {
        if v["kind"] == "SQL" {
            v["sql"].clone()
        } else {
            Value::Null
        }
    };
    for p in params {
        let value = &values[p.id];
        let rows = value.as_array().map(Vec::as_slice).unwrap_or_default();
        match p.kind {
            Kind::SqlText { .. } => text(value, Context::Query),
            Kind::ValueRows => rows.iter().for_each(|r| {
                text(&spec(&r["value"]), Context::Expression);
                // The older rows hold a bare expression rather than a value spec.
                text(&r["expression"], Context::Expression);
            }),
            Kind::Actions => rows.iter().for_each(|r| {
                text(&spec(&r["spec"]), Context::Expression);
                text(&r["value"], Context::Expression);
            }),
            _ => {}
        }
    }
    out
}

/// Validate every untrusted fragment of a node (`guardNode`): the first refusal, if any.
pub async fn guard_node(engine: &impl SqlEngine, params: &[Param], values: &Value) -> Result<(), Refusal> {
    for (sql, context) in fragments(params, values) {
        validate(engine, &sql, context).await?;
    }
    Ok(())
}
