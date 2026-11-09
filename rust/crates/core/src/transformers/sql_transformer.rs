use crate::sqlguard::splice_query;
use crate::{Ctx, Kind, Param, Ports, Result, Transformer};

pub struct SqlTransformer;

impl Transformer for SqlTransformer {
    fn id(&self) -> &'static str {
        "SQLTransformer"
    }

    fn summary(&self) -> &'static str {
        "Any DuckDB SELECT over the incoming rows, which the query reads as `input`."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[Param::new(
            "sql",
            "Query",
            Kind::SqlText {
                placeholder: "SELECT * FROM input",
            },
            "A single DuckDB SELECT that reads the incoming rows as the table input.",
        )
        .default("SELECT * FROM input")];
        P
    }

    // The compiler's SQL guard has already validated `sql` (Kind::SqlText).
    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let statement = ctx.str("sql").trim();
        let input = ctx.input("input");
        let sql = if statement.is_empty() {
            format!("SELECT * FROM {input}")
        } else {
            splice_query(statement, input)
        };
        Ok(Ports::from([("output".into(), sql)]))
    }
}
