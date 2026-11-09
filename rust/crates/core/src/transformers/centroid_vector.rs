use super::replace_geometry;
use crate::{Ctx, Ports, Result, Transformer};

pub struct CentroidVector;

impl Transformer for CentroidVector {
    fn id(&self) -> &'static str {
        "CentroidVector"
    }

    fn summary(&self) -> &'static str {
        "Replaces each feature with its centroid, which may fall outside a concave shape."
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        replace_geometry(ctx, self.id(), |s| format!("ST_Centroid({s})"), false)
    }
}
