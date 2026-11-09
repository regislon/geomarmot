//! Port of `transformers/polygon-to-h3/index.js`: the `h3_polyfill` kernel (h3o) fills each
//! polygon, one row per (feature, cell) with the cell's hexagon.

use crate::h3::H3_INDEX_COLUMN;
use crate::{
    Ctx, KernelRequest, Kind, Param, Ports, Result, Step, Transformer, find_geometry_column, geometry_expression,
    js_number, qid,
};
use serde_json::Value;

pub struct PolygonToH3;

const FID: &str = "_pv_fid";
const NO_GEOMETRY: &str = "This input has no geometry to fill.";

impl Transformer for PolygonToH3 {
    fn id(&self) -> &'static str {
        "PolygonToH3"
    }

    fn summary(&self) -> &'static str {
        "Fills polygons with H3 cells: one row per cell, carrying its polygon's attributes."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[
            Param::new(
                "resolution",
                "Resolution",
                Kind::Select(&[
                    ("0", "H3 resolution 0."),
                    ("1", "H3 resolution 1."),
                    ("2", "H3 resolution 2."),
                    ("3", "H3 resolution 3."),
                    ("4", "H3 resolution 4."),
                    ("5", "H3 resolution 5."),
                    ("6", "H3 resolution 6."),
                    ("7", "H3 resolution 7."),
                    ("8", "H3 resolution 8."),
                    ("9", "H3 resolution 9."),
                    ("10", "H3 resolution 10."),
                    ("11", "H3 resolution 11."),
                    ("12", "H3 resolution 12."),
                    ("13", "H3 resolution 13."),
                    ("14", "H3 resolution 14."),
                    ("15", "H3 resolution 15."),
                ]),
                "The H3 resolution of the cells, from 0 (continent-sized) to 15 (under a square metre).",
            )
            .default("7"),
            Param::new(
                "mode",
                "Polygon fill mode",
                Kind::Select(&[
                    (
                        "ContainsCentroid",
                        "A cell is taken when its centroid is inside the polygon.",
                    ),
                    (
                        "ContainsBoundary",
                        "A cell is taken when it lies wholly inside the polygon.",
                    ),
                    ("Covers", "A cell is taken when it overlaps the polygon at all."),
                    (
                        "CoversBoundingBox",
                        "A cell is taken when it overlaps the polygon's bounding box.",
                    ),
                ]),
                "Which cells count as covering a polygon, from the strictest to the most generous.",
            )
            .default("ContainsCentroid"),
            Param::new(
                "indexColumn",
                "Index attribute",
                Kind::String {
                    placeholder: "",
                    units: "",
                },
                "The name of the attribute that holds each row's H3 cell index.",
            )
            .default(H3_INDEX_COLUMN),
            Param::new(
                "geometry",
                "Geometry",
                Kind::Select(&[
                    ("Hexagons", "Each row's geometry is its cell's hexagon."),
                    ("None (index only)", "No geometry; only the index."),
                ]),
                "Whether each output row carries its cell's hexagon as geometry, or just the index.",
            )
            .default("Hexagons"),
        ];
        P
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn needs_lonlat(&self) -> bool {
        true
    }

    fn prepare(&self, ctx: &Ctx) -> Result<Vec<Step>> {
        let g = find_geometry_column(ctx.schema("input")).ok_or(NO_GEOMETRY)?;
        let resolution = js_number(ctx.params.get("resolution").unwrap_or(&Value::from(7)))
            .filter(|r| r.fract() == 0.0 && (0.0..=15.0).contains(r))
            .ok_or("The resolution must be a whole number from 0 to 15.")?;
        let mode = Some(ctx.str("mode"))
            .filter(|m| !m.is_empty())
            .unwrap_or("ContainsCentroid");
        let (source, fid) = (ctx.table_name("src"), qid(FID));
        Ok(vec![
            // A table, not a view: the ids must not be recomputed between this read and the join.
            Step::Exec(format!(
                "CREATE OR REPLACE TABLE {source} AS SELECT row_number() OVER () AS {fid}, * FROM {}",
                ctx.input("input")
            )),
            Step::Kernel(KernelRequest {
                op: format!("h3_polyfill:{resolution}:{mode}"),
                input_sql: format!(
                    "SELECT {fid}::BIGINT, ST_AsWKB({}) FROM {source} WHERE {} IS NOT NULL",
                    geometry_expression(&g),
                    qid(&g.name)
                ),
                output: ctx.table_name("fill"),
            }),
        ])
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let g = find_geometry_column(ctx.schema("input")).ok_or(NO_GEOMETRY)?;
        let column = qid(&g.name);
        let index = qid(Some(ctx.str("indexColumn"))
            .filter(|c| !c.is_empty())
            .unwrap_or(H3_INDEX_COLUMN));
        let shape = if ctx.params.get("geometry").and_then(Value::as_str).unwrap_or("Hexagons") == "Hexagons" {
            format!(", f.geometry AS {column}")
        } else {
            String::new()
        };
        Ok(Ports::from([(
            "output".into(),
            format!(
                "SELECT s.* EXCLUDE ({fid}, {column}), f.cell AS {index}{shape} FROM {} s JOIN {} f ON s.{fid} = f.key",
                ctx.table_name("src"),
                qid(&ctx.table_name("fill")),
                fid = qid(FID),
            ),
        )]))
    }
}
