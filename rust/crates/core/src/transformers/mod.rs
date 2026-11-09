//! One module per transformer, ported from `transformers/<id>/index.js`.

mod area_on_area_overlayer;
mod attribute_filter;
mod bufferer;
mod densify_features;
mod dissolver;
mod feature_joiner;
mod h3_geometry_from_index;
mod h3_geometry_from_position;
mod merge_line_segments;
mod minimum_bounding_circle;
mod per_feature;
mod polygon_to_h3;
mod positional_h3_index;
mod reprojector;
mod simplify_features;
mod smooth_vectors;
mod vertex_creator;
mod vertex_creator_sql;

use crate::Transformer;

pub static ALL: &[&dyn Transformer] = &[
    &area_on_area_overlayer::AreaOnAreaOverlayer,
    &attribute_filter::AttributeFilter,
    &bufferer::Bufferer,
    &dissolver::Dissolver,
    &feature_joiner::FeatureJoiner,
    &h3_geometry_from_index::H3GeometryFromIndex,
    &minimum_bounding_circle::MinimumBoundingCircle,
    &reprojector::Reprojector,
    &densify_features::DensifyFeatures,
    &merge_line_segments::MergeLineSegments,
    &simplify_features::SimplifyFeatures,
    &smooth_vectors::SmoothVectors,
    &vertex_creator::VertexCreator,
    &h3_geometry_from_position::H3GeometryFromPosition,
    &polygon_to_h3::PolygonToH3,
    &positional_h3_index::PositionalH3Index,
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
