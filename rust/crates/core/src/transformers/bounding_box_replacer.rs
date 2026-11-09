use crate::{Ctx, Kind, Param, Ports, Result, Transformer, find_geometry_column, geometry_expression, qid};

pub struct BoundingBoxReplacer;

fn bounds(e: &str) -> String {
    format!(", ST_XMin({e}) AS minx, ST_YMin({e}) AS miny, ST_XMax({e}) AS maxx, ST_YMax({e}) AS maxy")
}

impl Transformer for BoundingBoxReplacer {
    fn id(&self) -> &'static str {
        "BoundingBoxReplacer"
    }

    fn summary(&self) -> &'static str {
        "Replaces geometry with its bounding box, per feature or one box for the whole input."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[
            Param::new(
                "mode",
                "Box",
                Kind::Select(&[
                    ("Per feature", "Each geometry becomes its own box; attributes are kept."),
                    (
                        "One box for everything",
                        "The whole input collapses to one row: the extent of all features.",
                    ),
                ]),
                "Whether every feature gets its own box, or the whole input becomes one box.",
            )
            .default("Per feature"),
            Param::new(
                "bounds",
                "Bounds attributes",
                Kind::Select(&[
                    (
                        "Add minx/miny/maxx/maxy",
                        "Add the box's corners as four numeric attributes.",
                    ),
                    ("None", "Only replace the geometry."),
                ]),
                "Whether to add the box's minimum and maximum coordinates as attributes next to it.",
            )
            .default("Add minx/miny/maxx/maxy"),
        ];
        P
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let g = find_geometry_column(ctx.schema("input")).ok_or("This input has no geometry to replace.")?;
        let (column, source, input) = (qid(&g.name), geometry_expression(&g), ctx.input("input"));
        let wanted = ctx.str("bounds") != "None";
        let sql = if ctx.str("mode") == "One box for everything" {
            let united = format!("ST_Extent_Agg({source})");
            let b = if wanted { bounds(&united) } else { String::new() };
            format!("SELECT {united} AS {column}{b} FROM {input}")
        } else {
            // ST_Envelope, not ST_Extent: the latter is DuckDB's BOX type, which is not a GEOMETRY.
            let b = if wanted { bounds(&source) } else { String::new() };
            format!("SELECT * EXCLUDE ({column}), ST_Envelope({source}) AS {column}{b} FROM {input}")
        };
        Ok(Ports::from([("output".into(), sql)]))
    }
}
