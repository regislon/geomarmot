//! Port of `transformers/positional-h3-index/index.js`: a dense tile's h3_index from its row
//! number, in SQL.

use crate::h3::{H3_INDEX_COLUMN, ROW_NUMBER_COLUMN, positional_index_expr, resolve_child_resolution, resolve_parent};
use crate::{Ctx, Kind, Param, Ports, Result, Transformer, qid};

pub struct PositionalH3Index;

/// The `parent` and `resolution` params PositionalH3Index and H3GeometryFromPosition share.
pub(super) const PARENT: Param = Param::new(
    "parent",
    "Parent cell",
    Kind::String {
        placeholder: "from the file name",
        units: "",
    },
    "The tile's parent H3 cell; blank takes it from the name of the file the Reader reads.",
);
pub(super) const RESOLUTION: Param = Param::new(
    "resolution",
    "Child resolution",
    Kind::String {
        placeholder: "from the row count",
        units: "",
    },
    "The resolution of the rows' cells; blank derives it from the row count, which must be a power of seven.",
);

impl Transformer for PositionalH3Index {
    fn id(&self) -> &'static str {
        "PositionalH3Index"
    }

    fn summary(&self) -> &'static str {
        "Derives each row's H3 index from its position in a dense positional tile."
    }

    fn params(&self) -> &'static [Param] {
        &[PARENT, RESOLUTION]
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn needs_row_count(&self) -> bool {
        true
    }

    fn needs_lonlat(&self) -> bool {
        true
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let parent = resolve_parent(ctx)?;
        let resolution = resolve_child_resolution(ctx, &parent)?;
        if !ctx.schema("input").iter().any(|c| c.name == ROW_NUMBER_COLUMN) {
            return Err(format!(
                "No \"{ROW_NUMBER_COLUMN}\" column — set the Reader's \"Row number\" to Yes so the row order survives."
            ));
        }
        let row = qid(ROW_NUMBER_COLUMN);
        let expr = positional_index_expr(&parent, resolution, &row)?;
        Ok(Ports::from([(
            "output".into(),
            format!(
                "SELECT * EXCLUDE ({row}), {expr} AS {} FROM {}",
                qid(H3_INDEX_COLUMN),
                ctx.input("input")
            ),
        )]))
    }
}
