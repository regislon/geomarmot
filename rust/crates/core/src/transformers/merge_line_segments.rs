//! Port of `transformers/merge-line-segments/index.js` (a `sqlGeometryTool`).

use super::per_feature;
use crate::{Ctx, Ports, Result, Transformer};

pub struct MergeLineSegments;

impl Transformer for MergeLineSegments {
    fn id(&self) -> &'static str {
        "MergeLineSegments"
    }

    fn summary(&self) -> &'static str {
        "Joins line segments that share endpoints into longer lines, feature by feature."
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        per_feature::replace(ctx, self.id(), |g| format!("ST_LineMerge({g})"))
    }
}
