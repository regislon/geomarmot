use super::no_geometry;
use crate::{Ctx, Kind, Param, Ports, Result, Transformer, find_geometry_column, geometry_expression, qid};

pub struct Dissolver;

impl Transformer for Dissolver {
    fn id(&self) -> &'static str {
        "Dissolver"
    }

    fn summary(&self) -> &'static str {
        "Merges the geometry of every row in a group into one shape, counting the parts."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[Param::new(
            "groupBy",
            "Dissolve by",
            Kind::Columns { port: "input" },
            "The attributes whose values define the groups to merge; leave empty for one shape overall.",
        )];
        P
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let g = find_geometry_column(ctx.schema("input")).ok_or_else(|| no_geometry("dissolve"))?;
        let groups: Vec<String> = ctx.strings("groupBy").iter().map(|c| qid(c)).collect();
        let mut selection = groups.clone();
        selection.push(format!("ST_Union_Agg({}) AS {}", geometry_expression(&g), qid(&g.name)));
        selection.push("count(*) AS parts".into());
        let group_by = if groups.is_empty() {
            String::new()
        } else {
            format!(" GROUP BY {}", groups.join(", "))
        };
        Ok(Ports::from([(
            "output".into(),
            format!("SELECT {} FROM {}{group_by}", selection.join(", "), ctx.input("input")),
        )]))
    }
}
