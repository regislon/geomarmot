use crate::{Ctx, Kind, LONLAT, Param, Ports, Probe, Result, Transformer, to_crs};

pub struct CoordinateSystemSetter;

fn label(ctx: &Ctx) -> &str {
    ctx.str("crs").trim()
}

impl Transformer for CoordinateSystemSetter {
    fn id(&self) -> &'static str {
        "CoordinateSystemSetter"
    }

    fn summary(&self) -> &'static str {
        "Labels the stream with a coordinate system without changing any coordinates."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[Param::new(
            "crs",
            "Coordinate System",
            Kind::String {
                placeholder: "EPSG:2056, ESRI:54009, +proj=moll",
                units: "",
            },
            "The coordinate system the coordinates are really in, as an EPSG or ESRI code or a PROJ string.",
        )];
        P
    }

    fn crs(&self, ctx: &Ctx) -> String {
        Some(label(ctx))
            .filter(|s| !s.is_empty())
            .unwrap_or(&ctx.incoming_crs)
            .to_string()
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        if label(ctx).is_empty() {
            return Err("Set the coordinate system to assign, such as EPSG:2056.".into());
        }
        Ok(Ports::from([(
            "output".into(),
            format!("SELECT * FROM {}", ctx.input("input")),
        )]))
    }

    // Not checked against the data — but a name PROJ cannot resolve would only fail later, at the map.
    fn check(&self, ctx: &Ctx) -> Option<Probe> {
        let crs = label(ctx);
        if crs.is_empty() || crs == LONLAT {
            return None;
        }
        let quoted = format!("\"{crs}\"");
        Some(Probe {
            sql: format!("SELECT {} AS probe", to_crs("ST_Point(0, 0)", crs, LONLAT)),
            error: Box::new(move |e| format!("PROJ does not know {quoted} ({e})")),
        })
    }
}
