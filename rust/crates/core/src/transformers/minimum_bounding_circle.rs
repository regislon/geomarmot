//! Port of `transformers/minimum-bounding-circle/index.js` (a `jsGeometryTool`): the
//! per-feature kernel runs next to the data instead of JSTS on the page.

use super::per_feature;
use crate::{Ctx, Ports, Result, Step, Transformer};

pub struct MinimumBoundingCircle;

impl Transformer for MinimumBoundingCircle {
    fn id(&self) -> &'static str {
        "MinimumBoundingCircle"
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn prepare(&self, ctx: &Ctx) -> Result<Vec<Step>> {
        per_feature::prepare(ctx, self.id(), "minimum_bounding_circle")
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        per_feature::sql(ctx, self.id())
    }
}
