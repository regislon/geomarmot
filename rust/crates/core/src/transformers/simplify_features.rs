//! Port of `transformers/simplify-features/index.js` (a `sqlGeometryTool`).

use super::per_feature;
use crate::{Ctx, Kind, Param, Ports, Result, Transformer, js_number};
use serde_json::Value;

pub struct SimplifyFeatures;

impl Transformer for SimplifyFeatures {
    fn id(&self) -> &'static str {
        "SimplifyFeatures"
    }

    fn summary(&self) -> &'static str {
        "Removes vertices within a tolerance while keeping every shape valid."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[Param::new(
            "tolerance",
            "Tolerance (degrees)",
            Kind::String {
                placeholder: "",
                units: "degrees",
            },
            "How far the simplified outline may stray from the original, in the stream's own units (degrees on lon/lat).",
        )
        .default("0.001")];
        P
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let tolerance = js_number(ctx.params.get("tolerance").unwrap_or(&Value::from(0.001)))
            .filter(|t| *t >= 0.0)
            .ok_or("Tolerance must be a positive number.")?;
        per_feature::replace(ctx, self.id(), |g| {
            format!("ST_SimplifyPreserveTopology({g}, {tolerance})")
        })
    }
}
