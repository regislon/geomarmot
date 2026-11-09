use crate::{Ctx, Ports, Result, Transformer, qid, qlit};
use serde_json::Value;

/// Ceiling on value-driven output ports (`MAX_FILTER_PORTS`).
const MAX_FILTER_PORTS: usize = 40;

pub struct AttributeFilter;

fn values(params: &Value) -> Vec<String> {
    // JS `String(value)` on each listed value; blanks are kept (they are real values).
    let list = params
        .get("values")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    list.iter()
        .take(MAX_FILTER_PORTS)
        .map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string()))
        .collect()
}

impl Transformer for AttributeFilter {
    fn id(&self) -> &'static str {
        "AttributeFilter"
    }

    fn outputs(&self, params: &Value) -> Vec<String> {
        let mut out: Vec<String> = (0..values(params).len()).map(|k| format!("v{k}")).collect();
        out.push("unfiltered".into());
        out
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let column = ctx.str("column");
        let input = ctx.input("input");
        let values = values(&ctx.params);
        let mut out = Ports::new();
        for (k, value) in values.iter().enumerate() {
            let sql = if column.is_empty() {
                format!("SELECT * FROM {input} WHERE FALSE")
            } else {
                format!("SELECT * FROM {input} WHERE {} = {}", qid(column), qlit(value))
            };
            out.insert(format!("v{k}"), sql);
        }
        let rest = if column.is_empty() || values.is_empty() {
            format!("SELECT * FROM {input}")
        } else {
            let matched: Vec<String> = values.iter().map(|v| qlit(v)).collect();
            let c = qid(column);
            format!(
                "SELECT * FROM {input} WHERE {c} IS NULL OR {c} NOT IN ({})",
                matched.join(", ")
            )
        };
        out.insert("unfiltered".into(), rest);
        Ok(out)
    }
}
