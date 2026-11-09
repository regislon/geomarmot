use crate::{Ctx, Kind, LONLAT, Param, Ports, Result, Transformer, find_geometry_column, geometry_expression, to_crs};

pub struct AddGeometryAttributes;

const MEASURES: &[&str] = &[
    "Area (ha)",
    "Perimeter (km)",
    "Vertices",
    "Geometry type",
    "Parts",
    "Centroid lon/lat",
];
const DEFAULT: &[&str] = &["Area (ha)", "Perimeter (km)", "Geometry type"];

impl Transformer for AddGeometryAttributes {
    fn id(&self) -> &'static str {
        "AddGeometryAttributes"
    }

    fn summary(&self) -> &'static str {
        "Adds measurements of each shape as attributes: area, perimeter, vertices, type and more."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[Param::new(
            "measures",
            "Add",
            Kind::Choices {
                choices: MEASURES,
                default: DEFAULT,
            },
            "Which measurements to add as attributes; area is in hectares and perimeter in kilometres.",
        )];
        P
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let g = find_geometry_column(ctx.schema("input")).ok_or("AddGeometryAttributes needs a geometry column.")?;
        let source = geometry_expression(&g);
        let metric = to_crs(&source, &ctx.incoming_crs, "EPSG:6933");
        let lonlat = to_crs(&source, &ctx.incoming_crs, LONLAT);
        let wanted = match ctx.params.get("measures") {
            None => DEFAULT.iter().map(|s| s.to_string()).collect(),
            Some(_) => ctx.strings("measures"),
        };
        let has = |m: &str| wanted.iter().any(|w| w == m);
        let mut additions = vec![];
        if has("Area (ha)") {
            additions.push(format!("ST_Area({metric}) / 10000 AS area_ha"));
        }
        if has("Perimeter (km)") {
            additions.push(format!("ST_Perimeter({metric}) / 1000 AS perimeter_km"));
        }
        if has("Vertices") {
            additions.push(format!("ST_NPoints({source}) AS vertices"));
        }
        if has("Geometry type") {
            additions.push(format!("ST_GeometryType({source}) AS geometry_type"));
        }
        if has("Parts") {
            additions.push(format!("ST_NumGeometries({source}) AS parts"));
        }
        if has("Centroid lon/lat") {
            additions.push(format!("ST_X(ST_Centroid({lonlat})) AS centroid_lon"));
            additions.push(format!("ST_Y(ST_Centroid({lonlat})) AS centroid_lat"));
        }
        let input = ctx.input("input");
        let sql = if additions.is_empty() {
            format!("SELECT * FROM {input}")
        } else {
            format!("SELECT *, {} FROM {input}", additions.join(", "))
        };
        Ok(Ports::from([("output".into(), sql)]))
    }
}
