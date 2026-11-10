//! The first raster transformers (docs/ographis-port-plan.md, spike R1). A raster port is a
//! footprint relation whose `raster` column names a raster the engine owns; the kernels read the
//! pixels next to it. Rust only: the JavaScript app has no rasters.
//!
//! - PointOnRasterValueExtractor: each feature gets the value of one band at its point (a
//!   point's own position, a line's or area's point on surface). NULL outside the raster or on
//!   nodata. The features must be in the raster's CRS (inputs share one CRS).
//! - RasterToPolygonCoercer: one area per connected patch of equal value (4-connected), nodata
//!   left out, with the value in `value`. Reads the whole band: refused above the cell limit.

use crate::{
    Ctx, Kind, Param, Ports, RasterRequest, Result, Step, Transformer, find_geometry_column, geometry_expression, qid,
};

const FID: &str = "_pv_fid";

const BAND: Param = Param::new(
    "band",
    "Band",
    Kind::String {
        placeholder: "1",
        units: "",
    },
    "The band to read, from 1.",
)
.default("1");

fn band(ctx: &Ctx) -> Result<usize> {
    let text = ctx.str("band").trim();
    let text = if text.is_empty() { "1" } else { text };
    text.parse::<usize>()
        .ok()
        .filter(|b| *b >= 1)
        .ok_or_else(|| format!("The band is a whole number from 1, not {text:?}."))
}

fn raster_sql(ctx: &Ctx, port: &str) -> String {
    format!("SELECT raster FROM {}", ctx.input(port))
}

fn check_raster_port(ctx: &Ctx, port: &str, id: &str) -> Result<()> {
    if ctx.schema(port).iter().any(|c| c.name == "raster") {
        Ok(())
    } else {
        Err(format!("{id}: connect a raster (a Reader of a GeoTIFF) to \"{port}\"."))
    }
}

pub struct PointOnRasterValueExtractor;

impl Transformer for PointOnRasterValueExtractor {
    fn id(&self) -> &'static str {
        "PointOnRasterValueExtractor"
    }

    fn summary(&self) -> &'static str {
        "Each feature gets the value of a raster band at its point."
    }

    fn inputs(&self) -> &'static [&'static str] {
        &["input", "raster"]
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[
            BAND,
            Param::new(
                "attribute",
                "Attribute",
                Kind::String {
                    placeholder: "raster_value",
                    units: "",
                },
                "The new attribute holding the value.",
            )
            .default("raster_value"),
        ];
        P
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn prepare(&self, ctx: &Ctx) -> Result<Vec<Step>> {
        check_raster_port(ctx, "raster", self.id())?;
        let g = find_geometry_column(ctx.schema("input"))
            .ok_or_else(|| format!("{} needs features with a geometry.", self.id()))?;
        let attribute = attribute(ctx);
        if ctx.schema("input").iter().any(|c| c.name == attribute) {
            return Err(format!("The input already has an attribute named {attribute:?}."));
        }
        let (source, fid) = (ctx.table_name("src"), qid(FID));
        let point = format!(
            "CASE WHEN ST_GeometryType({g}) = 'POINT' THEN {g} ELSE ST_PointOnSurface({g}) END",
            g = geometry_expression(&g)
        );
        Ok(vec![
            Step::Exec(format!(
                "CREATE OR REPLACE TABLE {source} AS SELECT row_number() OVER () AS {fid}, * FROM {}",
                ctx.input("input")
            )),
            Step::Raster(RasterRequest {
                op: "sample".into(),
                raster_sql: raster_sql(ctx, "raster"),
                input_sql: format!(
                    "SELECT {fid}::BIGINT, ST_X(p), ST_Y(p) FROM (SELECT {fid}, {point} AS p FROM {source} WHERE {} IS NOT NULL)",
                    qid(&g.name)
                ),
                output: ctx.table_name("value"),
                band: band(ctx)?,
            }),
        ])
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        Ok(Ports::from([(
            "output".into(),
            format!(
                "SELECT s.* EXCLUDE ({fid}), v.value AS {a} FROM {} s LEFT JOIN {} v ON s.{fid} = v.key ORDER BY s.{fid}",
                ctx.table_name("src"),
                qid(&ctx.table_name("value")),
                fid = qid(FID),
                a = qid(&attribute(ctx)),
            ),
        )]))
    }
}

fn attribute(ctx: &Ctx) -> String {
    match ctx.str("attribute").trim() {
        "" => "raster_value".into(),
        a => a.into(),
    }
}

pub struct RasterToPolygonCoercer;

impl Transformer for RasterToPolygonCoercer {
    fn id(&self) -> &'static str {
        "RasterToPolygonCoercer"
    }

    fn summary(&self) -> &'static str {
        "One area per patch of equal value of a raster band, with the value in \"value\"."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[BAND];
        P
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn prepare(&self, ctx: &Ctx) -> Result<Vec<Step>> {
        check_raster_port(ctx, "input", self.id())?;
        Ok(vec![Step::Raster(RasterRequest {
            op: "polygonize".into(),
            raster_sql: raster_sql(ctx, "input"),
            input_sql: String::new(),
            output: ctx.table_name("areas"),
            band: band(ctx)?,
        })])
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        Ok(Ports::from([(
            "output".into(),
            format!("SELECT value, geometry FROM {}", qid(&ctx.table_name("areas"))),
        )]))
    }
}
