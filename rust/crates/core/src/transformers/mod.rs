//! One module per transformer, ported from `transformers/<id>/index.js`.

mod aggregator;
mod area_on_area_overlayer;
mod attribute_correlation;
mod attribute_filter;
mod attribute_histogram;
mod bufferer;
mod dissolver;
mod duplicate_filter;
mod feature_joiner;
mod h3_geometry_from_index;
mod list_unique_values;
mod minimum_bounding_circle;
mod per_feature;
mod reprojector;
mod statistics_calculator;
mod test_filter;
mod tester;
mod unioner;

use crate::{Ctx, Transformer, qid, qlit};
use serde_json::Value;

pub static ALL: &[&dyn Transformer] = &[
    &area_on_area_overlayer::AreaOnAreaOverlayer,
    &attribute_filter::AttributeFilter,
    &bufferer::Bufferer,
    &dissolver::Dissolver,
    &feature_joiner::FeatureJoiner,
    &h3_geometry_from_index::H3GeometryFromIndex,
    &minimum_bounding_circle::MinimumBoundingCircle,
    &reprojector::Reprojector,
    &duplicate_filter::DuplicateFilter,
    &test_filter::TestFilter,
    &tester::Tester,
    &aggregator::Aggregator,
    &statistics_calculator::StatisticsCalculator,
    &attribute_correlation::AttributeCorrelation,
    &attribute_histogram::AttributeHistogram,
    &list_unique_values::ListUniqueValues,
    &unioner::Unioner,
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

/// Ceiling on value- and rule-driven output ports (`MAX_FILTER_PORTS`).
const MAX_FILTER_PORTS: usize = 40;

/// The comparison operators of conditions and rules (`OPERATORS`).
const OPERATORS: &[&str] = &[
    "=",
    "!=",
    ">",
    ">=",
    "<",
    "<=",
    "contains",
    "starts with",
    "is null",
    "is not null",
];

/// The rows of a list param (`ctx.params.x || []`).
fn rows<'a>(ctx: &'a Ctx, id: &str) -> &'a [Value] {
    ctx.params
        .get(id)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

/// JavaScript's `String(row.key ?? "")`.
fn field(row: &Value, key: &str) -> String {
    match row.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
    }
}

/// One comparison as SQL (`OPERATORS[operator](qid(column), value)`), None for an unknown operator.
fn comparison(column: &str, operator: &str, value: &str) -> Option<String> {
    let c = qid(column);
    Some(match operator {
        "=" | ">" | ">=" | "<" | "<=" => format!("{c} {operator} {}", qlit(value)),
        "!=" => format!("{c} <> {}", qlit(value)),
        "contains" => format!("{c} LIKE {}", qlit(&format!("%{value}%"))),
        "starts with" => format!("{c} LIKE {}", qlit(&format!("{value}%"))),
        "is null" => format!("{c} IS NULL"),
        "is not null" => format!("{c} IS NOT NULL"),
        _ => return None,
    })
}

/// NULL counts as "did not pass", so a row never vanishes from both ports (`truthy`).
fn truthy(predicate: &str) -> String {
    format!("COALESCE({predicate}, FALSE)")
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
