use super::no_geometry;
use crate::{
    Ctx, LONLAT, Ports, Result, Transformer, find_geometry_column, geometry_expression, js_number, qid, qlit, to_crs,
};
use serde_json::Value;

pub struct Bufferer;

/// The PROJ definition each feature is buffered in, built from its own centroid; None = no projection.
fn projection(kind: &str, geom: &str) -> Option<String> {
    match kind {
        "same_as_feature" => None,
        "individual_utm" => Some(format!(
            "'EPSG:' || ((CASE WHEN ST_Y(ST_Centroid({geom})) >= 0 THEN 32600 ELSE 32700 END) + \
             least(60, greatest(1, floor((ST_X(ST_Centroid({geom})) + 180) / 6) + 1)))::INT::VARCHAR"
        )),
        _ => Some(format!(
            "'+proj=aeqd +lat_0=' || ST_Y(ST_Centroid({geom})) || ' +lon_0=' || ST_X(ST_Centroid({geom})) || \
             ' +datum=WGS84 +units=m'"
        )),
    }
}

impl Transformer for Bufferer {
    fn id(&self) -> &'static str {
        "Bufferer"
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let g = find_geometry_column(ctx.schema("input")).ok_or_else(|| no_geometry("buffer"))?;
        let distance = js_number(ctx.params.get("distance").unwrap_or(&Value::from("1000")))
            .ok_or("Distance must be a number of metres.")?;
        let source = geometry_expression(&g);
        let kind = Some(ctx.str("crs"))
            .filter(|s| !s.is_empty())
            .unwrap_or("azimuthal_equidistant");
        let base = to_crs(&source, &ctx.incoming_crs, LONLAT);
        let buffered = match projection(kind, &base) {
            Some(p) => to_crs(
                &format!(
                    "ST_Transform(ST_Buffer(ST_Transform({base}, {lonlat}, {p}, always_xy := true), {distance}), \
                     {p}, {lonlat}, always_xy := true)",
                    lonlat = qlit(LONLAT)
                ),
                LONLAT,
                &ctx.incoming_crs,
            ),
            None => format!("ST_Buffer({source}, {distance})"),
        };
        let column = qid(&g.name);
        Ok(Ports::from([(
            "output".into(),
            format!(
                "SELECT * EXCLUDE ({column}), {buffered} AS {column} FROM {}",
                ctx.input("input")
            ),
        )]))
    }
}
