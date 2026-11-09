//! Port of `transformers/h3-geometry-from-position/index.js`: PositionalH3Index and
//! H3GeometryFromIndex in one node, hexagons from the `h3_cell_boundary` kernel.

use super::h3_geometry_from_index::{cell_steps, sample_step, sample_where};
use super::positional_h3_index::{PARENT, RESOLUTION};
use crate::h3::{H3_INDEX_COLUMN, ROW_NUMBER_COLUMN, positional_expr_for};
use crate::{Ctx, Kind, LONLAT, Param, Ports, Result, Step, Transformer, qid};

pub struct H3GeometryFromPosition;

impl Transformer for H3GeometryFromPosition {
    fn id(&self) -> &'static str {
        "H3GeometryFromPosition"
    }

    fn summary(&self) -> &'static str {
        "Turns a dense positional tile's row order straight into indexes and hexagons."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[
            PARENT,
            RESOLUTION,
            Param::new(
                "sample",
                "Sample every Nth",
                Kind::Select(&[
                    ("Auto", "Aim for about 50,000 cells."),
                    ("All", "Every cell."),
                    ("10", "One row in 10."),
                    ("100", "One row in 100."),
                    ("1000", "One row in 1000."),
                    ("10000", "One row in 10000."),
                ]),
                "How many rows get a hexagon: all, one in N by row number, or enough for about 50,000.",
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

    fn needs_schema(&self) -> bool {
        true
    }

    fn needs_row_count(&self) -> bool {
        true
    }

    fn crs(&self, _ctx: &Ctx) -> String {
        LONLAT.into()
    }

    fn prepare(&self, ctx: &Ctx) -> Result<Vec<Step>> {
        let expr = positional_expr_for(ctx, "")?;
        let filter = sample_where(sample_step(ctx), &qid(ROW_NUMBER_COLUMN));
        let cells = format!("SELECT DISTINCT {expr} AS cell FROM {}{filter}", ctx.input("input"));
        Ok(cell_steps(ctx, &cells))
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let expr = positional_expr_for(ctx, "v")?;
        let filter = sample_where(sample_step(ctx), &format!("v.{}", qid(ROW_NUMBER_COLUMN)));
        let geometry = qid(Some(ctx.str("geometryColumn"))
            .filter(|g| !g.is_empty())
            .unwrap_or("geometry"));
        Ok(Ports::from([(
            "output".into(),
            format!(
                "SELECT v.* EXCLUDE ({}), {expr} AS {}, g.geometry AS {geometry} FROM {} v \
                 JOIN {} g ON {expr} = g.key{filter}",
                qid(ROW_NUMBER_COLUMN),
                qid(H3_INDEX_COLUMN),
                ctx.input("input"),
                qid(&ctx.table_name("cells"))
            ),
        )]))
    }
}
