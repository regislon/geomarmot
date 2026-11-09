use serde_json::Value;

use super::value_sql;
use crate::sqlguard::splice_expression;
use crate::{Ctx, Kind, Param, Ports, Result, Transformer, qid};

pub struct AttributeManager;

/// Convert's target types, as SQL. TRY_CAST: a value that does not convert becomes empty (NULL).
const CONVERT_SQL: &[(&str, &str)] = &[
    ("Text", "VARCHAR"),
    ("Integer", "BIGINT"),
    ("Decimal", "DOUBLE"),
    ("Boolean", "BOOLEAN"),
    ("Date", "DATE"),
    ("Date and time", "TIMESTAMP"),
];

/// An edit's value, from its value spec, or from the older raw-SQL `value` field.
fn edit_value_sql(action: &Value) -> Option<String> {
    if action["spec"].is_object() {
        return value_sql(&action["spec"]);
    }
    let raw = action["value"].as_str().map(str::trim).filter(|v| !v.is_empty())?;
    Some(splice_expression(raw))
}

/// One edit as a SELECT list plus the columns it leaves, or None for a row not filled in yet.
fn attribute_edit(action: &Value, columns: &[String]) -> Option<(String, Vec<String>)> {
    let s = |k: &str| action[k].as_str().unwrap_or_default();
    let (column, target) = (s("column"), s("target"));
    let has = !column.is_empty() && columns.iter().any(|c| c == column);
    let (c, t) = (qid(column), qid(target));
    let mut kept = columns.to_vec();
    let selection = match s("action") {
        "Set value" if has => format!("* REPLACE (({}) AS {c})", edit_value_sql(action)?),
        "Rename" if has && !target.is_empty() => {
            // Every column named, so the renamed one keeps its place (`* RENAME` is a parser error here).
            let names: Vec<String> = columns
                .iter()
                .map(|n| if n == column { format!("{c} AS {t}") } else { qid(n) })
                .collect();
            kept = columns
                .iter()
                .map(|n| if n == column { target.into() } else { n.clone() })
                .collect();
            names.join(", ")
        }
        "Copy to" if has && !target.is_empty() => {
            kept.push(target.into());
            format!("*, {c} AS {t}")
        }
        "Create" if !target.is_empty() => {
            let value = edit_value_sql(action)?;
            kept.push(target.into());
            format!("*, ({value}) AS {t}")
        }
        "Convert" if has => {
            let (_, ty) = CONVERT_SQL.iter().find(|(name, _)| *name == s("to"))?;
            format!("* REPLACE (TRY_CAST({c} AS {ty}) AS {c})")
        }
        "Remove" if has => {
            kept.retain(|n| n != column);
            format!("* EXCLUDE ({c})")
        }
        _ => return None,
    };
    Some((selection, kept))
}

impl Transformer for AttributeManager {
    fn id(&self) -> &'static str {
        "AttributeManager"
    }

    fn summary(&self) -> &'static str {
        "Sets, renames, copies, creates, converts and removes attributes — in order, in one node."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[Param::new(
            "actions",
            "Edits",
            Kind::Actions,
            "The edits to apply, top to bottom; each one sees the attributes as the edits above it left them.",
        )];
        P
    }

    fn needs_schema(&self) -> bool {
        true
    }

    // The compiler's SQL guard has already validated every SQL value.
    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let mut columns: Vec<String> = ctx.schema("input").iter().map(|c| c.name.clone()).collect();
        let mut relation = ctx.input("input").to_string();
        for action in ctx.params["actions"].as_array().into_iter().flatten() {
            if let Some((selection, kept)) = attribute_edit(action, &columns) {
                relation = format!("(SELECT {selection} FROM {relation})");
                columns = kept;
            }
        }
        Ok(Ports::from([("output".into(), format!("SELECT * FROM {relation}"))]))
    }
}
