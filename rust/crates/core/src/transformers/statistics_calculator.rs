use crate::{Ctx, Kind, Param, Ports, Result, Transformer, qid};
use serde_json::Value;

pub struct StatisticsCalculator;

/// Each statistic works both as an aggregate and as a window function, so one table serves the
/// Summary port and the Complete port. Range is max − min: DuckDB has no range aggregate.
const STATISTICS: &[&str] = &[
    "Minimum",
    "Maximum",
    "Sum",
    "Mean",
    "Median",
    "Range",
    "Standard deviation",
    "Standard deviation (population)",
    "Mode",
    "Total count",
    "Numeric count",
    "Value count",
];

fn statistic(name: &str, c: &str) -> Option<String> {
    Some(match name {
        "Minimum" => format!("min({c})"),
        "Maximum" => format!("max({c})"),
        "Sum" => format!("sum({c})"),
        "Mean" => format!("avg({c})"),
        "Median" => format!("median({c})"),
        "Range" => format!("max({c}) - min({c})"),
        "Standard deviation" => format!("stddev_samp({c})"),
        "Standard deviation (population)" => format!("stddev_pop({c})"),
        "Mode" => format!("mode({c})"),
        "Total count" => "count(*)".into(),
        "Numeric count" => format!("count({c})"),
        "Value count" => format!("count(DISTINCT {c})"),
        _ => return None,
    })
}

impl Transformer for StatisticsCalculator {
    fn id(&self) -> &'static str {
        "StatisticsCalculator"
    }

    fn summary(&self) -> &'static str {
        "Statistics of numeric attributes per group, as a summary or attached to every row."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[
            Param::new(
                "groupBy",
                "Group by",
                Kind::Columns { port: "input" },
                "The attributes whose values define a group; leave empty for statistics over the whole input.",
            ),
            Param::new(
                "attributes",
                "Attributes",
                Kind::Columns { port: "input" },
                "The numeric attributes to compute statistics of; only numeric columns are offered.",
            ),
            Param::new(
                "stats",
                "Statistics",
                Kind::Choices {
                    choices: STATISTICS,
                    default: &["Sum", "Mean", "Minimum", "Maximum", "Standard deviation"],
                },
                "Which statistics to compute for every chosen attribute, each becoming its own column.",
            ),
        ];
        P
    }

    fn outputs(&self, _params: &Value) -> Vec<String> {
        vec!["summary".into(), "complete".into()]
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let groups: Vec<String> = ctx.strings("groupBy").iter().map(|c| qid(c)).collect();
        let stats = ctx.strings("stats");
        let mut terms: Vec<(String, String)> = Vec::new();
        for attribute in ctx.strings("attributes") {
            for name in &stats {
                if let Some(sql) = statistic(name, &qid(&attribute)) {
                    let suffix = name.to_lowercase().split_whitespace().collect::<Vec<_>>().join("_");
                    terms.push((sql, format!("{attribute}_{suffix}")));
                }
            }
        }
        if terms.is_empty() {
            terms.push(("count(*)".into(), "count".into()));
        }
        let input = ctx.input("input");
        let (group_clause, over) = if groups.is_empty() {
            (String::new(), "OVER ()".to_string())
        } else {
            let g = groups.join(", ");
            (format!(" GROUP BY {g}"), format!("OVER (PARTITION BY {g})"))
        };
        let summary: Vec<String> = groups
            .iter()
            .cloned()
            .chain(terms.iter().map(|(sql, alias)| format!("{sql} AS {}", qid(alias))))
            .collect();
        let complete: Vec<String> = terms
            .iter()
            .map(|(sql, alias)| format!("{sql} {over} AS {}", qid(alias)))
            .collect();
        Ok(Ports::from([
            (
                "summary".into(),
                format!("SELECT {} FROM {input}{group_clause}", summary.join(", ")),
            ),
            (
                "complete".into(),
                format!("SELECT *, {} FROM {input}", complete.join(", ")),
            ),
        ]))
    }
}
