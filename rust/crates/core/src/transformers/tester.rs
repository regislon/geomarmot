use super::{OPERATORS, comparison, field, rows, truthy};
use crate::{Cell, Ctx, Kind, Param, Ports, Result, Transformer};
use serde_json::Value;

pub struct Tester;

impl Transformer for Tester {
    fn id(&self) -> &'static str {
        "Tester"
    }

    fn summary(&self) -> &'static str {
        "Splits rows into those that pass a set of conditions and those that fail."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[
            Param::new(
                "logic",
                "Combine with",
                Kind::Select(&[
                    ("AND", "A row passes when every condition holds."),
                    ("OR", "A row passes when any condition holds."),
                ]),
                "How the conditions combine into one test: all of them, or any of them.",
            )
            .default("AND"),
            Param::new(
                "conditions",
                "Conditions",
                Kind::Rows(&[
                    ("column", Cell::Column),
                    ("operator", Cell::Pick(OPERATORS)),
                    ("value", Cell::Text),
                ]),
                "Each condition is an attribute, an operator and, for most operators, a value to compare with.",
            ),
        ];
        P
    }

    fn outputs(&self, _params: &Value) -> Vec<String> {
        vec!["passed".into(), "failed".into()]
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        // buildPredicate: complete conditions only, joined by the logic.
        let parts: Vec<String> = rows(ctx, "conditions")
            .iter()
            .filter(|c| !field(c, "column").is_empty() && !field(c, "operator").is_empty())
            .filter_map(|c| comparison(&field(c, "column"), &field(c, "operator"), &field(c, "value")))
            .map(|p| format!("({p})"))
            .collect();
        let input = ctx.input("input");
        if parts.is_empty() {
            return Ok(Ports::from([
                ("passed".into(), format!("SELECT * FROM {input}")),
                ("failed".into(), format!("SELECT * FROM {input} WHERE FALSE")),
            ]));
        }
        let joiner = if ctx.str("logic") == "OR" { " OR " } else { " AND " };
        let test = truthy(&parts.join(joiner));
        Ok(Ports::from([
            ("passed".into(), format!("SELECT * FROM {input} WHERE {test}")),
            ("failed".into(), format!("SELECT * FROM {input} WHERE NOT {test}")),
        ]))
    }
}
