use crate::{Ctx, Kind, Param, Ports, Result, Transformer, qid};

pub struct Sorter;

impl Transformer for Sorter {
    fn id(&self) -> &'static str {
        "Sorter"
    }

    fn summary(&self) -> &'static str {
        "Orders rows by one or more attributes, each ascending or descending."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[Param::new(
            "sorts",
            "Sort by",
            Kind::Sorts,
            "The attributes to sort on, most important first, each ascending or descending.",
        )];
        P
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let keys: Vec<String> = ctx.params["sorts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| {
                let column = s["column"].as_str().filter(|c| !c.is_empty())?;
                let direction = if s["direction"] == "DESC" { "DESC" } else { "ASC" };
                Some(format!("{} {direction}", qid(column)))
            })
            .collect();
        let order = if keys.is_empty() {
            String::new()
        } else {
            format!(" ORDER BY {}", keys.join(", "))
        };
        Ok(Ports::from([(
            "output".into(),
            format!("SELECT * FROM {}{order}", ctx.input("input")),
        )]))
    }
}
