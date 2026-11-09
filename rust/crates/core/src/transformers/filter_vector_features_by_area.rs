use crate::{
    Ctx, Kind, Param, Ports, Result, Transformer, find_geometry_column, geometry_expression, js_number, to_crs,
};
use serde_json::Value;

pub struct FilterVectorFeaturesByArea;

impl Transformer for FilterVectorFeaturesByArea {
    fn id(&self) -> &'static str {
        "FilterVectorFeaturesByArea"
    }

    fn summary(&self) -> &'static str {
        "Keeps features whose area falls between two bounds in hectares; the rest are removed."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[
            Param::new(
                "min",
                "Minimum area (ha)",
                Kind::String {
                    placeholder: "",
                    units: "ha",
                },
                "The smallest area, in hectares, that a feature may have to be kept.",
            )
            .default("0"),
            Param::new(
                "max",
                "Maximum area (ha)",
                Kind::String {
                    placeholder: "no limit",
                    units: "ha",
                },
                "The largest area, in hectares, that a kept feature may have; blank means no upper limit.",
            ),
        ];
        P
    }

    fn outputs(&self, _params: &Value) -> Vec<String> {
        vec!["kept".into(), "removed".into()]
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let g =
            find_geometry_column(ctx.schema("input")).ok_or("FilterVectorFeaturesByArea needs a geometry column.")?;
        let area = format!(
            "ST_Area({}) / 10000",
            to_crs(&geometry_expression(&g), &ctx.incoming_crs, "EPSG:6933")
        );
        let bad = || "Area bounds must be numbers of hectares.".to_string();
        let min = js_number(ctx.params.get("min").unwrap_or(&Value::from(0))).ok_or_else(bad)?;
        let mut test = format!("{area} >= {min}");
        let max = ctx.str("max").trim();
        if !max.is_empty() {
            let max = js_number(&Value::from(max)).ok_or_else(bad)?;
            test += &format!(" AND {area} <= {max}");
        }
        let input = ctx.input("input");
        Ok(Ports::from([
            ("kept".into(), format!("SELECT * FROM {input} WHERE {test}")),
            ("removed".into(), format!("SELECT * FROM {input} WHERE NOT ({test})")),
        ]))
    }
}
