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
        // One line per condition, as a table: its AND/OR with the line before, parentheses to
        // group lines. `logic` (the older all-AND or all-OR switch) still applies to lines
        // without their own AND/OR.
        const P: &[Param] = &[Param::new(
            "conditions",
            "Conditions",
            Kind::Rows(&[
                ("join", Cell::Pick(&["AND", "OR"])),
                ("open", Cell::Pick(&["", "(", "(("])),
                ("column", Cell::Column),
                ("operator", Cell::Pick(OPERATORS)),
                ("value", Cell::Text),
                ("close", Cell::Pick(&["", ")", "))"])),
            ]),
            "Each line is AND or OR with the line before, an attribute, an operator and a value; parentheses group lines.",
        )];
        P
    }

    fn outputs(&self, _params: &Value) -> Vec<String> {
        vec!["passed".into(), "failed".into()]
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        // buildPredicate: complete conditions only, each joined by its own AND/OR (else `logic`),
        // with its parentheses.
        let logic = if ctx.str("logic") == "OR" { "OR" } else { "AND" };
        let mut depth = 0i32;
        let mut parts = Vec::new();
        for c in rows(ctx, "conditions") {
            if field(c, "column").is_empty() || field(c, "operator").is_empty() {
                continue;
            }
            let Some(test) = comparison(&field(c, "column"), &field(c, "operator"), &field(c, "value")) else {
                continue;
            };
            let (opens, closes) = (
                field(c, "open").matches('(').count(),
                field(c, "close").matches(')').count(),
            );
            depth += opens as i32 - closes as i32;
            if depth < 0 {
                return Err("The parentheses do not balance: a ) closes nothing.".into());
            }
            let join = match field(c, "join").as_str() {
                j @ ("AND" | "OR") => j.to_string(),
                _ => logic.to_string(),
            };
            let lead = if parts.is_empty() {
                String::new()
            } else {
                format!(" {join} ")
            };
            parts.push(format!("{lead}{}({test}){}", "(".repeat(opens), ")".repeat(closes)));
        }
        if depth != 0 {
            return Err("The parentheses do not balance: a ( is never closed.".into());
        }
        let input = ctx.input("input");
        if parts.is_empty() {
            return Ok(Ports::from([
                ("passed".into(), format!("SELECT * FROM {input}")),
                ("failed".into(), format!("SELECT * FROM {input} WHERE FALSE")),
            ]));
        }
        let test = truthy(&parts.concat());
        Ok(Ports::from([
            ("passed".into(), format!("SELECT * FROM {input} WHERE {test}")),
            ("failed".into(), format!("SELECT * FROM {input} WHERE NOT {test}")),
        ]))
    }
}
