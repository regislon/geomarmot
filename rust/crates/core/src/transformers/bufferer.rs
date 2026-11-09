use super::no_geometry;
use crate::{
    Ctx, KernelRequest, Kind, LONLAT, Param, Ports, Result, Step, Transformer, find_geometry_column,
    geometry_expression, js_number, qid, qlit, to_crs,
};
use serde_json::Value;

pub struct Bufferer;

/// Row number and longitude/latitude geometry kept beside the input while the kernels run.
const FID: &str = "_bf_fid";
const LL: &str = "_bf_lonlat";

fn kind(ctx: &Ctx) -> &str {
    Some(ctx.str("crs"))
        .filter(|s| !s.is_empty())
        .unwrap_or("azimuthal_equidistant")
}

fn distance(ctx: &Ctx) -> Result<f64> {
    js_number(ctx.params.get("distance").unwrap_or(&Value::from("1000")))
        .ok_or_else(|| "Distance must be a number of metres.".into())
}

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

    fn summary(&self) -> &'static str {
        "Buffers every feature by a distance in metres, in a projection chosen per feature."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[
            Param::new(
                "distance",
                "Distance (m)",
                Kind::String { placeholder: "", units: "m" },
                "How far to buffer, in metres for the per-feature projections, or in the stream's own units for same_as_feature.",
            )
            .default("1000"),
            Param::new(
                "crs",
                "Coordinate system",
                Kind::Select(&[
                    ("azimuthal_equidistant", "A projection centred on each feature; distances from the centre are true."),
                    ("individual_utm", "The UTM zone of each feature's centroid."),
                    ("same_as_feature", "No reprojection: the distance is in the stream's own units (degrees on lon/lat)."),
                ]),
                "The coordinate system each feature is buffered in, which decides what the distance is measured in.",
            )
            .default("azimuthal_equidistant"),
        ];
        P
    }

    fn needs_schema(&self) -> bool {
        true
    }

    /// Azimuthal equidistant: each feature goes into the projection centred on its own
    /// centroid in Rust (geodesics, as PROJ's aeqd), DuckDB buffers it there, and Rust brings
    /// it back. In SQL, one PROJ transform per feature costs ~3.6 ms a row (48 s for 13,401 plots).
    fn prepare(&self, ctx: &Ctx) -> Result<Vec<Step>> {
        if kind(ctx) != "azimuthal_equidistant" {
            return Ok(vec![]);
        }
        let g = find_geometry_column(ctx.schema("input")).ok_or_else(|| no_geometry("buffer"))?;
        let d = distance(ctx)?;
        let base = to_crs(&geometry_expression(&g), &ctx.incoming_crs, LONLAT);
        let (src, fwd, buf, back) = (
            ctx.table_name("src"),
            ctx.table_name("fwd"),
            ctx.table_name("buf"),
            ctx.table_name("back"),
        );
        let (fid, ll) = (qid(FID), qid(LL));
        Ok(vec![
            Step::Exec(format!(
                "CREATE OR REPLACE TABLE {src} AS SELECT row_number() OVER () AS {fid}, *, {base} AS {ll} FROM {}",
                ctx.input("input")
            )),
            Step::Kernel(KernelRequest {
                op: "aeqd_forward".into(),
                input_sql: format!(
                    "SELECT {fid}::BIGINT, ST_AsWKB(ST_Collect([ST_Centroid({ll}), {ll}])) FROM {src} \
                     WHERE {ll} IS NOT NULL AND NOT ST_IsEmpty({ll})"
                ),
                output: fwd.clone(),
            }),
            Step::Exec(format!(
                "CREATE OR REPLACE TABLE {buf} AS SELECT key, ST_Buffer(geometry, {d}) AS geometry FROM {}",
                qid(&fwd)
            )),
            Step::Kernel(KernelRequest {
                op: "aeqd_inverse".into(),
                input_sql: format!(
                    "SELECT b.key::BIGINT, ST_AsWKB(ST_Collect([ST_Centroid(s.{ll}), b.geometry])) \
                     FROM {buf} b JOIN {src} s ON s.{fid} = b.key"
                ),
                output: back,
            }),
        ])
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let g = find_geometry_column(ctx.schema("input")).ok_or_else(|| no_geometry("buffer"))?;
        let distance = distance(ctx)?;
        let source = geometry_expression(&g);
        let kind = kind(ctx);
        if kind == "azimuthal_equidistant" {
            let column = qid(&g.name);
            let back = to_crs("k.geometry", LONLAT, &ctx.incoming_crs);
            return Ok(Ports::from([(
                "output".into(),
                format!(
                    "SELECT s.* EXCLUDE ({fid}, {ll}, {column}), {back} AS {column} FROM {src} s \
                     LEFT JOIN {k} k ON s.{fid} = k.key ORDER BY s.{fid}",
                    fid = qid(FID),
                    ll = qid(LL),
                    src = ctx.table_name("src"),
                    k = qid(&ctx.table_name("back")),
                ),
            )]));
        }
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
