//! One module per transformer, ported from `transformers/<id>/index.js`.

mod area_on_area_overlayer;
mod attribute_filter;
mod bufferer;
mod dissolver;
mod feature_joiner;
mod h3_geometry_from_index;
mod minimum_bounding_circle;
mod per_feature;
mod reprojector;

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
