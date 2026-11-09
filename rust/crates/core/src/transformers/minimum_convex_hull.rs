use super::replace_geometry;
use crate::{Ctx, Kind, Param, Ports, Result, Transformer};

pub struct MinimumConvexHull;

impl Transformer for MinimumConvexHull {
    fn id(&self) -> &'static str {
        "MinimumConvexHull"
    }

    fn summary(&self) -> &'static str {
        "The convex hull of each feature, or one hull around the whole layer."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[Param::new(
            "scope",
            "Hull around",
            Kind::Select(&[
                ("Each feature", "Every geometry gets its own hull; attributes are kept."),
                ("The whole layer", "One hull around all geometries, as a single row."),
            ]),
            "Whether each feature gets its own hull, or one hull encloses the whole layer.",
        )
        .default("Each feature")];
        P
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        if ctx.str("scope") == "The whole layer" {
            replace_geometry(ctx, self.id(), |s| format!("ST_ConvexHull(ST_Union_Agg({s}))"), true)
        } else {
            replace_geometry(ctx, self.id(), |s| format!("ST_ConvexHull({s})"), false)
        }
    }
}
