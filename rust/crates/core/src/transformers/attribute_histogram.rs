use crate::{Ctx, Kind, Param, Ports, Result, Transformer, js_number, qid};
use serde_json::Value;

pub struct AttributeHistogram;

impl Transformer for AttributeHistogram {
    fn id(&self) -> &'static str {
        "AttributeHistogram"
    }

    fn summary(&self) -> &'static str {
        "Bins an attribute's values into equal-width bins and counts each bin."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[
            Param::new(
                "column",
                "Attribute",
                Kind::Column { port: "input" },
                "The numeric attribute whose values are binned and counted; NULLs are skipped.",
            ),
            Param::new(
                "bins",
                "Bins",
                Kind::String {
                    placeholder: "",
                    units: "",
                },
                "How many equal-width bins the range from minimum to maximum is divided into.",
            )
            .default("20"),
        ];
        P
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let column = ctx.str("column");
        if column.is_empty() {
            return Err("Choose an attribute to bin.".into());
        }
        let column = qid(column);
        // Math.max(1, Math.round(Number(bins ?? 20))): round half up.
        let raw = ctx
            .params
            .get("bins")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(Value::from(20));
        let bins = js_number(&raw)
            .map(|n| (n + 0.5).floor().max(1.0))
            .ok_or("Bins must be a number.")? as i64;
        let input = ctx.input("input");
        Ok(Ports::from([(
            "output".into(),
            format!(
                "WITH b AS (SELECT {column} AS v, min({column}) OVER () AS lo, max({column}) OVER () AS hi \
                 FROM {input} WHERE {column} IS NOT NULL), \
                 w AS (SELECT *, (hi - lo) / {bins} AS width FROM b) \
                 SELECT bin, min(lo + bin * width) AS bin_start, min(lo + (bin + 1) * width) AS bin_end, count(*) AS n FROM (\
                 SELECT *, least({}, floor(CASE WHEN width = 0 THEN 0 ELSE (v - lo) / width END))::INT AS bin FROM w\
                 ) GROUP BY bin ORDER BY bin",
                bins - 1
            ),
        )]))
    }
}
