//! "What should this hold?" without writing SQL (app/src/core/valuespec.js): a constant, an
//! attribute, a two-operand formula or SQL, each compiled to one SQL expression.

use crate::sqlguard::splice_expression;
use crate::{js_number, qid, qlit};
use serde_json::Value;

fn text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// A typed literal, as SQL; None for a number that is not one.
fn literal_sql(raw: &Value, kind: &str) -> Option<String> {
    let raw = text(raw);
    match kind {
        "Number" if raw.is_empty() => None,
        "Number" => js_number(&Value::String(raw)).map(|n| n.to_string()),
        "Boolean" => Some(
            if ["true", "yes", "1"].contains(&raw.trim().to_lowercase().as_str()) {
                "TRUE"
            } else {
                "FALSE"
            }
            .into(),
        ),
        "Null" => Some("NULL".into()),
        _ => Some(qlit(&raw)),
    }
}

/// One side of a formula: a column, or a typed literal.
fn operand_sql(operand: &Value) -> Option<String> {
    if !operand.is_object() {
        return None;
    }
    let s = |k: &str| operand.get(k).and_then(Value::as_str).unwrap_or_default();
    if s("kind") == "Attribute" {
        return Some(s("column")).filter(|c| !c.is_empty()).map(qid);
    }
    literal_sql(
        &operand["value"],
        Some(s("type")).filter(|t| !t.is_empty()).unwrap_or("Number"),
    )
}

/// A spec as SQL, or None when it is not filled in yet.
pub fn value_sql(spec: &Value) -> Option<String> {
    if !spec.is_object() {
        return None;
    }
    let s = |k: &str| spec.get(k).and_then(Value::as_str).unwrap_or_default();
    match s("kind") {
        "Attribute" => Some(s("column")).filter(|c| !c.is_empty()).map(qid),
        "Formula" => {
            let (l, r) = (operand_sql(&spec["left"])?, operand_sql(&spec["right"])?);
            Some(match Some(s("operator")).filter(|o| !o.is_empty()).unwrap_or("+") {
                "+" => format!("({l} + {r})"),
                "-" => format!("({l} - {r})"),
                "×" => format!("({l} * {r})"),
                // NULLIF: division by zero is a missing answer, not a crash.
                "÷" => format!("({l} / NULLIF({r}, 0))"),
                "join text" => format!("({l} || {r})"),
                _ => return None,
            })
        }
        "SQL" => Some(s("sql").trim()).filter(|q| !q.is_empty()).map(splice_expression),
        _ => literal_sql(
            &spec["value"],
            Some(s("type")).filter(|t| !t.is_empty()).unwrap_or("Text"),
        ),
    }
}
