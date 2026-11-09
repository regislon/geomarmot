use super::value_sql;
use crate::sqlguard::splice_query;
use crate::{Ctx, Kind, Param, Ports, Probe, Result, Transformer, qid, qlit};

pub struct AttributeCreator;

const ADDS_NOTHING: &str = "The query runs but adds no attribute. Keep `input.*` and add at least one new column.";

impl Transformer for AttributeCreator {
    fn id(&self) -> &'static str {
        "AttributeCreator"
    }

    fn summary(&self) -> &'static str {
        "Adds attributes to every row, from a builder or from a DuckDB SELECT."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[
            Param::new(
                "mode",
                "How",
                Kind::Select(&[
                    (
                        "Builder",
                        "Name each new attribute and pick its value: constant, attribute, formula or SQL.",
                    ),
                    ("SQL query", "Write the whole SELECT over the table `input`."),
                ]),
                "Whether new attributes are described one by one in the builder or written as one SELECT.",
            )
            .default("Builder"),
            Param::new(
                "creates",
                "New attributes",
                Kind::ValueRows,
                "One row per new attribute: its name and its value, which may be a constant, an attribute, a formula or SQL.",
            ),
            Param::new(
                "sql",
                "Query",
                Kind::SqlText {
                    placeholder: "SELECT\n  input.*,\n  <expression> AS <new_column>\nFROM input",
                },
                "A single DuckDB SELECT over the table input that keeps input.* and adds at least one new column.",
            ),
        ];
        P
    }

    fn needs_schema(&self) -> bool {
        true
    }

    // The compiler's SQL guard has already validated `sql` and every SQL value.
    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let input = ctx.input("input");
        let pass = format!("SELECT * FROM {input}");
        if ctx.str("mode") == "SQL query" {
            let statement = ctx.str("sql").trim();
            let sql = if statement.is_empty() {
                pass
            } else {
                splice_query(statement, input)
            };
            return Ok(Ports::from([("output".into(), sql)]));
        }
        let additions: Vec<String> = ctx.params["creates"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| {
                let name = c["name"].as_str().filter(|n| !n.is_empty())?;
                Some(format!("{} AS {}", value_sql(&c["value"])?, qid(name)))
            })
            .collect();
        let sql = if additions.is_empty() {
            pass
        } else {
            format!("SELECT *, {} FROM {input}", additions.join(", "))
        };
        Ok(Ports::from([("output".into(), sql)]))
    }

    /// `checkSql(..., { requireNewColumns: true })`: the query must add an attribute.
    fn check(&self, ctx: &Ctx) -> Option<Probe> {
        let statement = ctx.str("sql").trim();
        let statement = statement.trim_end_matches(|c: char| c == ';' || c.is_whitespace());
        if ctx.str("mode") != "SQL query" || statement.is_empty() {
            return None;
        }
        let before: Vec<String> = ctx.schema("input").iter().map(|c| qlit(&c.name)).collect();
        let new = if before.is_empty() {
            String::new()
        } else {
            format!(" WHERE column_name NOT IN ({})", before.join(", "))
        };
        Some(Probe {
            sql: format!(
                "SELECT CASE WHEN count(*) = 0 THEN error({}) END FROM (DESCRIBE ({})){new}",
                qlit(ADDS_NOTHING),
                splice_query(statement, ctx.input("input"))
            ),
            error: Box::new(|e| {
                if e.contains(ADDS_NOTHING) {
                    ADDS_NOTHING.into()
                } else {
                    e.trim_start_matches("Error:").trim_start().into()
                }
            }),
        })
    }
}
