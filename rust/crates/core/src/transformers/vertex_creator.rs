//! Port of `transformers/vertex-creator/index.js`; the SQL is in `vertex_creator_sql.rs`.

use super::vertex_creator_sql::vertex_creator_sql;
use crate::{Ctx, Kind, Param, Ports, Result, Transformer};
use serde_json::Value;

pub struct VertexCreator;

impl Transformer for VertexCreator {
    fn id(&self) -> &'static str {
        "VertexCreator"
    }

    fn summary(&self) -> &'static str {
        "Adds, inserts or replaces one vertex, or turns coordinate columns into points."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[
            Param::new(
                "mode",
                "Mode",
                Kind::Select(&[
                    ("Add Point", "Append the vertex to the feature."),
                    (
                        "Replace with Point",
                        "Discard the geometry; the feature becomes the new point.",
                    ),
                    (
                        "Insert Point at Index",
                        "Insert the vertex before the vertex at the index.",
                    ),
                    ("Replace Point at Index", "Replace the vertex at the index."),
                ]),
                "What to do with the new vertex: append it, replace the geometry with it, or put it at an index.",
            )
            .default("Add Point"),
            Param::new(
                "x",
                "X Value",
                Kind::ValueSpec,
                "The new vertex's X (longitude or easting): a constant, an attribute, a formula or SQL.",
            ),
            Param::new(
                "y",
                "Y Value",
                Kind::ValueSpec,
                "The new vertex's Y (latitude or northing): a constant, an attribute, a formula or SQL.",
            ),
            Param::new(
                "z",
                "Z Value (optional)",
                Kind::ValueSpec,
                "The new vertex's Z, if any; leave empty for a two-dimensional vertex.",
            ),
            Param::new(
                "index",
                "Index",
                Kind::ValueSpec,
                "The position to insert at or replace, counted from 0; negative counts back from the last vertex.",
            ),
            Param::new(
                "crs",
                "Coordinate System",
                Kind::String {
                    placeholder: "blank keeps the stream's; EPSG:2056…",
                    units: "",
                },
                "For Replace with Point: the coordinate system the new points are in, which labels the stream below.",
            ),
            Param::new(
                "removeAttributes",
                "Remove Attributes",
                Kind::Select(&[
                    ("No", "Keep every attribute."),
                    ("Yes", "Drop the attributes the X, Y and Z values were read from."),
                ]),
                "Whether the attributes the coordinates came from are dropped once they are in the geometry.",
            )
            .default("No"),
            Param::new(
                "zConflict",
                "Measures/Z Conflict Value",
                Kind::Select(&[
                    (
                        "Compute",
                        "Interpolate the missing Z, or give every vertex the new vertex's Z.",
                    ),
                    (
                        "None (Drop Values)",
                        "Drop Z when the input and the new vertex disagree.",
                    ),
                    ("Custom Value", "Fill missing Z with the Custom Z value."),
                ]),
                "How to resolve a feature and a new vertex that disagree about having a Z coordinate.",
            )
            .default("Compute"),
            Param::new(
                "zCustom",
                "Custom Z",
                Kind::String {
                    placeholder: "",
                    units: "",
                },
                "The Z value given to vertices that have none, when the Z conflict rule is Custom Value.",
            )
            .default("0"),
            Param::new(
                "ignoreDuplicates",
                "Ignore Duplicated Coordinates",
                Kind::Select(&[
                    ("Yes", "Do not append a vertex equal to the last one."),
                    ("No", "Append it anyway."),
                ]),
                "For Add Point: whether a new vertex at the same place as the last vertex is skipped.",
            )
            .default("Yes"),
            Param::new(
                "closedLines",
                "Closed Line Handling",
                Kind::Select(&[
                    (
                        "Create Polygon",
                        "A line whose ends meet, with at least three corners, becomes a polygon.",
                    ),
                    ("Create Line", "It stays a closed line."),
                ]),
                "What a line becomes when the edit makes its first and last vertices meet.",
            )
            .default("Create Polygon"),
        ];
        P
    }

    fn outputs(&self, _params: &Value) -> Vec<String> {
        vec!["output".into(), "rejected".into()]
    }

    fn needs_schema(&self) -> bool {
        true
    }

    /// A new point in a named CRS is the one case where the stream changes CRS.
    fn crs(&self, ctx: &Ctx) -> String {
        let crs = ctx.str("crs").trim();
        if ctx.str("mode") == "Replace with Point" && !crs.is_empty() {
            crs.into()
        } else {
            ctx.incoming_crs.clone()
        }
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        vertex_creator_sql(&ctx.params, ctx.input("input"), ctx.schema("input"))
    }
}
