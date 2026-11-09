use super::{MAX_FILTER_PORTS, OPERATORS, comparison, field, rows, truthy};
use crate::{Cell, Ctx, Kind, Param, Ports, Result, Transformer};
use serde_json::Value;

pub struct TestFilter;

impl Transformer for TestFilter {
    fn id(&self) -> &'static str {
        "TestFilter"
    }

    fn summary(&self) -> &'static str {
        "Routes each row to the first of several rules it satisfies, or to Unfiltered."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[Param::new(
            "rules",
            "Rules, in order",
            Kind::Rows(&[
                ("label", Cell::Text),
                ("column", Cell::Column),
                ("operator", Cell::Pick(OPERATORS)),
                ("value", Cell::Text),
            ]),
            "Each rule has a label, an attribute, an operator and a value; the first rule a row satisfies wins.",
        )];
        P
    }

    fn outputs(&self, params: &Value) -> Vec<String> {
        let n = params
            .get("rules")
            .and_then(Value::as_array)
            .map_or(0, |r| r.len().min(MAX_FILTER_PORTS));
        let mut out: Vec<String> = (0..n).map(|k| format!("r{k}")).collect();
        out.push("unfiltered".into());
        out
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let input = ctx.input("input");
        let mut out = Ports::new();
        let mut earlier: Vec<String> = Vec::new();
        for (index, rule) in rows(ctx, "rules").iter().take(MAX_FILTER_PORTS).enumerate() {
            let column = field(rule, "column");
            let predicate = (!column.is_empty())
                .then(|| comparison(&column, &field(rule, "operator"), &field(rule, "value")))
                .flatten()
                .map(|p| truthy(&format!("({p})")));
            let sql = match &predicate {
                Some(p) if earlier.is_empty() => format!("SELECT * FROM {input} WHERE {p}"),
                Some(p) => format!("SELECT * FROM {input} WHERE {p} AND NOT ({})", earlier.join(" OR ")),
                None => format!("SELECT * FROM {input} WHERE FALSE"),
            };
            out.insert(format!("r{index}"), sql);
            earlier.extend(predicate);
        }
        let rest = if earlier.is_empty() {
            format!("SELECT * FROM {input}")
        } else {
            format!("SELECT * FROM {input} WHERE NOT ({})", earlier.join(" OR "))
        };
        out.insert("unfiltered".into(), rest);
        Ok(out)
    }
}
