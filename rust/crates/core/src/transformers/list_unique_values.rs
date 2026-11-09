use crate::{Ctx, Kind, Param, Ports, Result, Transformer, qid};

pub struct ListUniqueValues;

impl Transformer for ListUniqueValues {
    fn id(&self) -> &'static str {
        "ListUniqueValues"
    }

    fn summary(&self) -> &'static str {
        "One row per distinct value of an attribute, with its count and share of all rows."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[Param::new(
            "column",
            "Attribute",
            Kind::Column { port: "input" },
            "The attribute whose distinct values are listed and counted, NULL included.",
        )];
        P
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let column = ctx.str("column");
        if column.is_empty() {
            return Err("Choose an attribute to list.".into());
        }
        let column = qid(column);
        Ok(Ports::from([(
            "output".into(),
            format!(
                "SELECT {column} AS value, count(*) AS n, round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS percent \
                 FROM {} GROUP BY {column} ORDER BY n DESC, 1",
                ctx.input("input")
            ),
        )]))
    }
}
