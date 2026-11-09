//! Port of `transformers/densify-features/index.js` (a `jsGeometryTool`): JTS's Densifier as the
//! `densify` kernel, then the `buffer(0)` JTS's Densifier gives polygons, in SQL.

use super::per_feature;
use crate::{Ctx, Kind, Param, Ports, Result, Step, Transformer, js_number, qid};
use serde_json::Value;

pub struct DensifyFeatures;

fn tolerance(ctx: &Ctx) -> Result<f64> {
    js_number(ctx.params.get("tolerance").unwrap_or(&Value::from(0.01)))
        .filter(|t| *t > 0.0)
        .ok_or_else(|| "Tolerance must be above zero.".into())
}

impl Transformer for DensifyFeatures {
    fn id(&self) -> &'static str {
        "DensifyFeatures"
    }

    fn summary(&self) -> &'static str {
        "Adds vertices so that no segment of a line or ring is longer than the tolerance."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[Param::new(
            "tolerance",
            "Max segment (degrees)",
            Kind::String {
                placeholder: "",
                units: "degrees",
            },
            "The longest a segment may be after densifying, in the stream's own units (degrees on lon/lat).",
        )
        .default("0.01")];
        P
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn prepare(&self, ctx: &Ctx) -> Result<Vec<Step>> {
        let op = format!("densify:{}", tolerance(ctx)?);
        let mut steps = per_feature::prepare(ctx, self.id(), &op)?;
        let shapes = qid(&ctx.table_name("shape"));
        steps.push(Step::Exec(format!(
            "CREATE OR REPLACE TABLE {shapes} AS SELECT key, CASE WHEN ST_GeometryType(geometry) IN \
             ('POLYGON', 'MULTIPOLYGON') THEN ST_Buffer(geometry, 0) ELSE geometry END AS geometry FROM {shapes}"
        )));
        Ok(steps)
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        per_feature::sql(ctx, self.id())
    }
}
