//! One module per transformer, ported from `transformers/<id>/index.js`.

mod add_geometry_attributes;
mod area_on_area_overlayer;
mod attribute_filter;
mod bounding_box_replacer;
mod bufferer;
mod centroid_vector;
mod coordinate_system_setter;
mod dissolver;
mod eliminate_coincident_points;
mod feature_joiner;
mod filter_vector_features_by_area;
mod h3_geometry_from_index;
mod minimum_bounding_box;
mod minimum_bounding_circle;
mod minimum_convex_hull;
mod per_feature;
mod representative_point_vector;
mod reprojector;

use crate::{Ctx, Ports, Result, Transformer, find_geometry_column, geometry_expression, qid};

pub static ALL: &[&dyn Transformer] = &[
    &area_on_area_overlayer::AreaOnAreaOverlayer,
    &attribute_filter::AttributeFilter,
    &bufferer::Bufferer,
    &dissolver::Dissolver,
    &feature_joiner::FeatureJoiner,
    &h3_geometry_from_index::H3GeometryFromIndex,
    &minimum_bounding_circle::MinimumBoundingCircle,
    &reprojector::Reprojector,
    &add_geometry_attributes::AddGeometryAttributes,
    &bounding_box_replacer::BoundingBoxReplacer,
    &centroid_vector::CentroidVector,
    &coordinate_system_setter::CoordinateSystemSetter,
    &eliminate_coincident_points::EliminateCoincidentPoints,
    &filter_vector_features_by_area::FilterVectorFeaturesByArea,
    &minimum_bounding_box::MinimumBoundingBox,
    &minimum_convex_hull::MinimumConvexHull,
    &representative_point_vector::RepresentativePointVector,
];

pub fn by_id(id: &str) -> Option<&'static dyn Transformer> {
    ALL.iter().copied().find(|t| t.id() == id)
}

/// The geometry-missing message the buffer/dissolve family share.
fn no_geometry(verb: &str) -> String {
    format!(
        "This input has no geometry to {verb}. If it came from PolygonToH3, set its Geometry to Hexagons — \
         or add an H3GeometryFromIndex before this node."
    )
}

/// `sqlGeometryTool`: replace the geometry by `build(source)`; `collapses` = an aggregate, one row.
fn replace_geometry(ctx: &Ctx, id: &str, build: impl Fn(&str) -> String, collapses: bool) -> Result<Ports> {
    let g = find_geometry_column(ctx.schema("input")).ok_or_else(|| format!("{id} needs a geometry column."))?;
    let (column, shaped, input) = (qid(&g.name), build(&geometry_expression(&g)), ctx.input("input"));
    // An aggregate cannot sit beside `*` in one SELECT.
    let sql = if collapses {
        format!("SELECT {shaped} AS {column} FROM {input}")
    } else {
        format!("SELECT * EXCLUDE ({column}), {shaped} AS {column} FROM {input}")
    };
    Ok(Ports::from([("output".into(), sql)]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn new_nodes_start_from_the_javascript_defaults() {
        let bufferer = crate::default_params(by_id("Bufferer").unwrap());
        assert_eq!(bufferer, json!({"distance": "1000", "crs": "azimuthal_equidistant"}));
        let joiner = crate::default_params(by_id("FeatureJoiner").unwrap());
        assert_eq!(joiner["keys"], json!([{"left": "", "right": ""}]));
        assert_eq!(joiner["suffix"], "_right");
        for t in ALL {
            assert!(!t.summary().is_empty(), "{} has no summary", t.id());
        }
    }
}
