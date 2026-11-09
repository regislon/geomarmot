use crate::{Ctx, Kind, Param, Ports, Result, Transformer, js_number};

pub struct Sampler;

impl Transformer for Sampler {
    fn id(&self) -> &'static str {
        "Sampler"
    }

    fn summary(&self) -> &'static str {
        "Takes a subset of rows: the first N, every Nth, or a random percentage."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[
            Param::new(
                "mode",
                "How",
                Kind::Select(&[
                    ("First N", "The first N rows in scan order."),
                    ("Every Nth", "One row in every N."),
                    (
                        "Random %",
                        "Each row kept independently with this percent chance (Bernoulli sampling).",
                    ),
                ]),
                "How rows are chosen: a head, a regular stride, or at random.",
            )
            .default("First N"),
            Param::new(
                "amount",
                "N (or percent)",
                Kind::String {
                    placeholder: "",
                    units: "",
                },
                "The number of rows for First N, the stride for Every Nth, or the percentage for Random %.",
            )
            .default("1000"),
        ];
        P
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let input = ctx.input("input");
        // JS `Math.round`: halves go up.
        let round = |n: f64| (n + 0.5).floor();
        let sql = match js_number(&ctx.params["amount"]).filter(|n| *n > 0.0) {
            None => format!("SELECT * FROM {input}"),
            // (bernoulli) is not optional: DuckDB's default system sampling picks whole vectors, so on a
            // small table it returns all the rows or none of them.
            Some(n) if ctx.str("mode") == "Random %" => {
                format!(
                    "SELECT * FROM {input} USING SAMPLE {} PERCENT (bernoulli)",
                    n.min(100.0)
                )
            }
            Some(n) if ctx.str("mode") == "Every Nth" => format!(
                "SELECT * EXCLUDE (_pv_rn) FROM (SELECT *, row_number() OVER () AS _pv_rn FROM {input}) WHERE _pv_rn % {} = 0",
                round(n).max(1.0)
            ),
            Some(n) => format!("SELECT * FROM {input} LIMIT {}", round(n)),
        };
        Ok(Ports::from([("output".into(), sql)]))
    }
}
