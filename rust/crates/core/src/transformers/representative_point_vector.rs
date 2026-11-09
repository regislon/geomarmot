use super::replace_geometry;
use crate::{Ctx, Ports, Result, Transformer};

pub struct RepresentativePointVector;

impl Transformer for RepresentativePointVector {
    fn id(&self) -> &'static str {
        "RepresentativePointVector"
    }

    fn summary(&self) -> &'static str {
        "Replaces each feature with a point guaranteed to lie inside it."
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        replace_geometry(ctx, self.id(), |s| format!("ST_PointOnSurface({s})"), false)
    }
}
