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
