//! Port of `transformers/h3-geometry-from-index/index.js`: hexagons from an H3 index column,
//! built by the `h3_cell_boundary` kernel (h3o) instead of h3-js.

use crate::{Ctx, KernelRequest, Kind, LONLAT, Param, Ports, Result, Step, Transformer, qid, thousands};

pub struct H3GeometryFromIndex;

const H3_INDEX_COLUMN: &str = "h3_index";
const AUTO_SAMPLE_TARGET: u64 = 50_000;
/// `MAX_MATERIALISED_CELLS` (app/src/core/limits.js).
const MAX_MATERIALISED_CELLS: u64 = 2_000_000;

fn column(ctx: &Ctx) -> String {
    qid(Some(ctx.str("indexColumn"))
        .filter(|c| !c.is_empty())
        .unwrap_or(H3_INDEX_COLUMN))
}

/// Take every Nth cell: what the user chose, or enough to keep Auto near 50,000 (`sampleStep`).
pub(super) fn sample_step(ctx: &Ctx) -> u64 {
    match Some(ctx.str("sample")).filter(|s| !s.is_empty()).unwrap_or("Auto") {
        "All" => 1,
        "Auto" => {
            let rows = ctx.row_count.unwrap_or(0);
            if rows <= AUTO_SAMPLE_TARGET {
                return 1;
            }
            let needed = rows.div_ceil(AUTO_SAMPLE_TARGET);
            [10, 100, 1000, 10_000, 100_000]
                .into_iter()
                .find(|s| *s >= needed)
                .unwrap_or(1_000_000)
        }
        n => n.parse::<u64>().unwrap_or(1).max(1),
    }
}

/// The sampling filter, used identically when collecting cells and when joining back (`sampleWhere`).
pub(super) fn sample_where(step: u64, expression: &str) -> String {
    if step <= 1 {
        String::new()
    } else {
        format!(" WHERE {expression} % {step} = 0")
    }
}

/// Materialise the hexagons of `cells` (a query with a `cell` column) into the `cells` table,
/// keyed by cell (`buildCellTable`).
pub(super) fn cell_steps(ctx: &Ctx, cells: &str) -> Vec<Step> {
    vec![
        Step::Cap {
            count_sql: format!("SELECT count(*) FROM ({cells})"),
            cap: MAX_MATERIALISED_CELLS,
            message: Box::new(|_| {
                format!(
                    "{} cells is the ceiling. Sample, or filter upstream.",
                    thousands(MAX_MATERIALISED_CELLS)
                )
            }),
        },
        // ponytail: VARCHAR indexes, as the fixtures; integer indexes (the JS engine accepts both) come with phase 3.
        Step::Kernel(KernelRequest {
            op: "h3_cell_boundary".into(),
            input_sql: format!("SELECT cell::VARCHAR, cell::VARCHAR FROM ({cells})"),
            output: ctx.table_name("cells"),
        }),
    ]
}

impl Transformer for H3GeometryFromIndex {
    fn id(&self) -> &'static str {
        "H3GeometryFromIndex"
    }

    fn summary(&self) -> &'static str {
        "Builds hexagon geometry from an existing H3 index column."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[
            Param::new(
                "indexColumn",
                "Index attribute",
                Kind::Column { port: "input" },
                "The attribute holding the H3 cell indexes, as text or as integers.",
            ),
            Param::new(
                "sample",
                "Sample every Nth",
                Kind::Select(&[
                    ("Auto", "Aim for about 50,000 cells."),
                    ("All", "Every cell."),
                    ("10", "One cell in 10."),
                    ("100", "One cell in 100."),
                    ("1000", "One cell in 1000."),
                    ("10000", "One cell in 10000."),
                ]),
                "How many cells to build hexagons for: all, one in N, or enough for about 50,000.",
            )
            .default("Auto"),
            Param::new(
                "geometryColumn",
                "Geometry attribute",
                Kind::String {
                    placeholder: "",
                    units: "",
                },
                "The name of the new geometry attribute holding each row's hexagon.",
            )
            .default("geometry"),
        ];
        P
    }

    fn needs_row_count(&self) -> bool {
        true
    }

    fn crs(&self, _ctx: &Ctx) -> String {
        LONLAT.into()
    }

    fn prepare(&self, ctx: &Ctx) -> Result<Vec<Step>> {
        let c = column(ctx);
        let filter = sample_where(sample_step(ctx), &format!("hash({c})"));
        let not_null = if filter.is_empty() {
            format!(" WHERE {c} IS NOT NULL")
        } else {
            format!("{filter} AND {c} IS NOT NULL")
        };
        let cells = format!("SELECT DISTINCT {c} AS cell FROM {}{not_null}", ctx.input("input"));
        Ok(cell_steps(ctx, &cells))
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let c = column(ctx);
        let filter = sample_where(sample_step(ctx), &format!("hash(v.{c})"));
        let geometry = qid(Some(ctx.str("geometryColumn"))
            .filter(|g| !g.is_empty())
            .unwrap_or("geometry"));
        Ok(Ports::from([(
            "output".into(),
            format!(
                "SELECT v.*, g.geometry AS {geometry} FROM {} v JOIN {} g ON v.{c} = g.key{filter}",
                ctx.input("input"),
                qid(&ctx.table_name("cells"))
            ),
        )]))
    }
}
