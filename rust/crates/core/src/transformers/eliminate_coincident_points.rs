use crate::{Ctx, Kind, Param, Ports, Result, Transformer, find_geometry_column, geometry_expression, js_number};
use serde_json::Value;

pub struct EliminateCoincidentPoints;

impl Transformer for EliminateCoincidentPoints {
    fn id(&self) -> &'static str {
        "EliminateCoincidentPoints"
    }

    fn summary(&self) -> &'static str {
        "Drops points that share a location, within a tolerance, keeping one per spot."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[Param::new(
            "tolerance",
            "Tolerance (degrees)",
            Kind::String {
                placeholder: "",
                units: "degrees",
            },
            "The grid size within which points count as coincident, in the stream's own units (degrees on lon/lat).",
        )
        .default("0.00001")];
        P
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let g =
            find_geometry_column(ctx.schema("input")).ok_or("EliminateCoincidentPoints needs a geometry column.")?;
        let tolerance = js_number(ctx.params.get("tolerance").unwrap_or(&Value::from(0.00001)))
            .filter(|t| *t > 0.0)
            .ok_or("Tolerance must be above zero.")?;
        let source = geometry_expression(&g);
        let cell = format!("(round(ST_X({source}) / {tolerance}), round(ST_Y({source}) / {tolerance}))");
        Ok(Ports::from([(
            "output".into(),
            format!(
                "SELECT * EXCLUDE (_pv_rn) FROM (SELECT *, row_number() OVER (PARTITION BY {cell}) AS _pv_rn \
                 FROM {}) WHERE _pv_rn = 1",
                ctx.input("input")
            ),
        )]))
    }
}
