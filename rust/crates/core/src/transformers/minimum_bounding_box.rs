//! Port of `transformers/minimum-bounding-box/index.js` (a `jsGeometryTool` on JSTS): native
//! DuckDB spatial has ST_MinimumRotatedRectangle (GEOS), so no kernel is needed here.

use super::replace_geometry;
use crate::{Ctx, Ports, Result, Transformer};

pub struct MinimumBoundingBox;

impl Transformer for MinimumBoundingBox {
    fn id(&self) -> &'static str {
        "MinimumBoundingBox"
    }

    fn summary(&self) -> &'static str {
        "The smallest rectangle around each feature, at any angle — not axis-aligned."
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        replace_geometry(ctx, self.id(), |s| format!("ST_MinimumRotatedRectangle({s})"), false)
    }
}
