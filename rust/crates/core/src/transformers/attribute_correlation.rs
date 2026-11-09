use crate::{Ctx, Kind, Param, Ports, Result, Transformer, qid, qlit};

pub struct AttributeCorrelation;

impl Transformer for AttributeCorrelation {
    fn id(&self) -> &'static str {
        "AttributeCorrelation"
    }

    fn summary(&self) -> &'static str {
        "Pearson correlation between every pair of the chosen numeric attributes, strongest first."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[Param::new(
            "columns",
            "Attributes",
            Kind::Columns { port: "input" },
            "The numeric attributes to correlate pairwise; at least two are needed.",
        )];
        P
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let columns = ctx.strings("columns");
        if columns.len() < 2 {
            return Err("Choose at least two numeric attributes.".into());
        }
        let mut pairs = Vec::new();
        for (i, a) in columns.iter().enumerate() {
            for b in &columns[i + 1..] {
                pairs.push(format!(
                    "SELECT {} AS attribute_a, {} AS attribute_b, corr({}, {}) AS r, count(*) AS n FROM {}",
                    qlit(a),
                    qlit(b),
                    qid(a),
                    qid(b),
                    ctx.input("input")
                ));
            }
        }
        Ok(Ports::from([(
            "output".into(),
            format!(
                "SELECT * FROM ({}) ORDER BY abs(r) DESC NULLS LAST",
                pairs.join(" UNION ALL ")
            ),
        )]))
    }
}
