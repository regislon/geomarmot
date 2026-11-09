//! Port of `transformers/smooth-vectors/index.js` (a `jsGeometryTool`): Chaikin passes in the
//! `smooth` kernel.

use super::per_feature;
use crate::{Ctx, Kind, Param, Ports, Result, Step, Transformer, js_number};
use serde_json::Value;

pub struct SmoothVectors;

impl Transformer for SmoothVectors {
    fn id(&self) -> &'static str {
        "SmoothVectors"
    }

    fn summary(&self) -> &'static str {
        "Rounds off corners by Chaikin subdivision; each pass doubles the vertices."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[Param::new(
            "iterations",
            "Passes",
            Kind::Select(&[
                ("1", "One pass: corners cut once."),
                ("2", "Two passes (default): noticeably round."),
                ("3", "Three passes: very round, eight times the vertices."),
                ("4", "Four passes: sixteen times the vertices."),
            ]),
            "How many times to cut every corner; each pass doubles the number of vertices.",
        )
        .default("2")];
        P
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn prepare(&self, ctx: &Ctx) -> Result<Vec<Step>> {
        let passes = js_number(ctx.params.get("iterations").unwrap_or(&Value::from(2)))
            .unwrap_or(2.0)
            .round()
            .max(1.0);
        per_feature::prepare(ctx, self.id(), &format!("smooth:{passes}"))
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        per_feature::sql(ctx, self.id())
    }
}
