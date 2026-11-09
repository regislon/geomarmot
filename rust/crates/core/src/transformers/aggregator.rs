use super::{field, rows};
use crate::{Cell, Ctx, Kind, Param, Ports, Result, Transformer, find_geometry_column, geometry_expression, qid};

pub struct Aggregator;

/// The aggregate functions the inspector offers.
const AGGREGATE_FUNCTIONS: &[&str] = &["count", "sum", "min", "max", "mean", "median", "count distinct"];

/// `AGGREGATE_SQL[func](column)`; `column` is "null" when none is chosen, as the JS template writes it.
fn aggregate(func: &str, column: &str) -> Option<String> {
    Some(match func {
        "count" if column == "null" => "count(*)".into(),
        "count" | "sum" | "min" | "max" | "median" => format!("{func}({column})"),
        "mean" => format!("avg({column})"),
        "count distinct" => format!("count(DISTINCT {column})"),
        _ => return None,
    })
}

impl Transformer for Aggregator {
    fn id(&self) -> &'static str {
        "Aggregator"
    }

    fn summary(&self) -> &'static str {
        "Groups rows and computes aggregates per group, optionally dissolving their geometry."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[
            Param::new(
                "groupBy",
                "Group by",
                Kind::Columns { port: "input" },
                "The attributes whose values define a group; leave empty to aggregate the whole input.",
            ),
            Param::new(
                "aggregates",
                "Aggregates",
                Kind::Rows(&[
                    ("func", Cell::Pick(AGGREGATE_FUNCTIONS)),
                    ("column", Cell::Column),
                    ("alias", Cell::Text),
                ]),
                "Each aggregate is a function, the attribute it runs over and an optional name for the result.",
            ),
            Param::new(
                "geometry",
                "Geometry",
                Kind::Select(&[
                    ("Drop", "The output has no geometry."),
                    (
                        "Dissolve",
                        "Merge each group's geometries into one shape with ST_Union_Agg.",
                    ),
                ]),
                "What happens to the geometry of the rows in each group: dropped, or merged into one shape.",
            )
            .default("Drop"),
        ];
        P
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let groups: Vec<String> = ctx.strings("groupBy").iter().map(|c| qid(c)).collect();
        let mut selection = groups.clone();
        for a in rows(ctx, "aggregates") {
            let (func, column) = (field(a, "func"), field(a, "column"));
            let target = if column.is_empty() { "null".into() } else { qid(&column) };
            let Some(sql) = aggregate(&func, &target) else { continue };
            let mut alias = field(a, "alias");
            if alias.is_empty() {
                let all = if column.is_empty() { "all" } else { &column };
                alias = format!("{}_{all}", func.split_whitespace().collect::<Vec<_>>().join("_"));
            }
            selection.push(format!("{sql} AS {}", qid(&alias)));
        }
        let dissolve = ctx.params.get("geometry").and_then(|v| v.as_str()) == Some("Dissolve");
        let geometry = find_geometry_column(ctx.schema("input")).filter(|_| dissolve);
        if selection.len() == groups.len() && geometry.is_none() {
            selection.push("count(*) AS \"count\"".into());
        }
        if let Some(g) = geometry {
            selection.push(format!("ST_Union_Agg({}) AS {}", geometry_expression(&g), qid(&g.name)));
        }
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
