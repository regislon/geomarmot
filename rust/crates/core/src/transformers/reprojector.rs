use crate::{Ctx, Ports, Probe, Result, Transformer, find_geometry_column, geometry_expression, qid, to_crs};

pub struct Reprojector;

fn destination(ctx: &Ctx) -> &str {
    ctx.str("to").trim()
}

impl Transformer for Reprojector {
    fn id(&self) -> &'static str {
        "Reprojector"
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn crs(&self, ctx: &Ctx) -> String {
        Some(destination(ctx))
            .filter(|s| !s.is_empty())
            .unwrap_or(&ctx.incoming_crs)
            .to_string()
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let to = destination(ctx);
        if to.is_empty() {
            return Err("Set a destination coordinate system, such as EPSG:2056.".into());
        }
        let g = find_geometry_column(ctx.schema("input")).ok_or("This input has no geometry to reproject.")?;
        let input = ctx.input("input");
        if to == ctx.incoming_crs {
            return Ok(Ports::from([("output".into(), format!("SELECT * FROM {input}"))]));
        }
        let column = qid(&g.name);
        let moved = to_crs(&geometry_expression(&g), &ctx.incoming_crs, to);
        Ok(Ports::from([(
            "output".into(),
            format!("SELECT * EXCLUDE ({column}), {moved} AS {column} FROM {input}"),
        )]))
    }

    fn check(&self, ctx: &Ctx) -> Option<Probe> {
        let to = destination(ctx);
        if to.is_empty() || to == ctx.incoming_crs {
            return None;
        }
        let quoted = format!("\"{to}\"");
        Some(Probe {
            sql: format!("SELECT {} AS probe", to_crs("ST_Point(0, 0)", &ctx.incoming_crs, to)),
            error: Box::new(move |e| format!("PROJ does not know {quoted} ({e})")),
        })
    }
}
