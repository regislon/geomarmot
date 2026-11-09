use std::collections::HashMap;

use crate::{Ctx, Kind, Param, Ports, Result, Transformer, qid};

pub struct AttributeRenamer;

impl Transformer for AttributeRenamer {
    fn id(&self) -> &'static str {
        "AttributeRenamer"
    }

    fn summary(&self) -> &'static str {
        "Renames attributes and leaves their values and column order untouched."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[Param::new(
            "renames",
            "Renames",
            Kind::Renames,
            "Pairs of existing attribute and new name; incomplete pairs are ignored until both are filled in.",
        )];
        P
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let renames: HashMap<&str, &str> = ctx.params["renames"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| Some((r["from"].as_str()?, r["to"].as_str()?)))
            .filter(|(from, to)| !from.is_empty() && !to.is_empty())
            .collect();
        let input = ctx.input("input");
        let columns = ctx.schema("input");
        let sql = if renames.is_empty() || columns.is_empty() {
            format!("SELECT * FROM {input}")
        } else {
            let selection: Vec<String> = columns
                .iter()
                .map(|c| match renames.get(c.name.as_str()) {
                    Some(to) => format!("{} AS {}", qid(&c.name), qid(to)),
                    None => qid(&c.name),
                })
                .collect();
            format!("SELECT {} FROM {input}", selection.join(", "))
        };
        Ok(Ports::from([("output".into(), sql)]))
    }
}
