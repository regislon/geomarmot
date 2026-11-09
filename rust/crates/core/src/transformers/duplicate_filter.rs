use crate::{Ctx, Kind, Param, Ports, Result, Transformer, qid};
use serde_json::Value;

pub struct DuplicateFilter;

impl Transformer for DuplicateFilter {
    fn id(&self) -> &'static str {
        "DuplicateFilter"
    }

    fn summary(&self) -> &'static str {
        "Keeps the first row for each key and sends the others out of Duplicate."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[Param::new(
            "keys",
            "Key attributes",
            Kind::Columns { port: "input" },
            "The attributes that together decide whether two rows are duplicates; geometry is allowed.",
        )];
        P
    }

    fn outputs(&self, _params: &Value) -> Vec<String> {
        vec!["unique".into(), "duplicate".into()]
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let input = ctx.input("input");
        let keys: Vec<String> = ctx.strings("keys").iter().map(|k| qid(k)).collect();
        if keys.is_empty() {
            return Ok(Ports::from([
                ("unique".into(), format!("SELECT * FROM {input}")),
                ("duplicate".into(), format!("SELECT * FROM {input} WHERE FALSE")),
            ]));
        }
        let numbered = format!(
            "SELECT *, row_number() OVER (PARTITION BY {}) AS _pv_rn FROM {input}",
            keys.join(", ")
        );
        Ok(Ports::from([
            (
                "unique".into(),
                format!("SELECT * EXCLUDE (_pv_rn) FROM ({numbered}) WHERE _pv_rn = 1"),
            ),
            (
                "duplicate".into(),
                format!("SELECT * EXCLUDE (_pv_rn) FROM ({numbered}) WHERE _pv_rn > 1"),
            ),
        ]))
    }
}
