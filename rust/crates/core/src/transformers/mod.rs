//! One module per transformer, ported from `transformers/<id>/index.js`.

mod area_on_area_overlayer;
mod attribute_creator;
mod attribute_filter;
mod attribute_keeper;
mod attribute_manager;
mod attribute_remover;
mod attribute_renamer;
mod bufferer;
mod dissolver;
mod feature_joiner;
mod h3_geometry_from_index;
mod minimum_bounding_circle;
mod per_feature;
mod reprojector;
mod sampler;
mod sorter;
mod sql_transformer;

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
    &attribute_creator::AttributeCreator,
    &attribute_keeper::AttributeKeeper,
    &attribute_manager::AttributeManager,
    &attribute_remover::AttributeRemover,
    &attribute_renamer::AttributeRenamer,
    &sql_transformer::SqlTransformer,
    &sorter::Sorter,
    &sampler::Sampler,
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

/// A typed literal as SQL (valuespec.js `literalSql`); None when a number does not parse.
fn literal_sql(raw: &str, kind: &str) -> Option<String> {
    match kind {
        "Number" if raw.is_empty() => None,
        "Number" => crate::js_number(&raw.into()).map(|n| n.to_string()),
        "Boolean" => {
            let t = raw.trim().to_lowercase();
            Some(
                if ["true", "yes", "1"].contains(&t.as_str()) {
                    "TRUE"
                } else {
                    "FALSE"
                }
                .into(),
            )
        }
        "Null" => Some("NULL".into()),
        _ => Some(crate::qlit(raw)),
    }
}

fn spec_str<'a>(v: &'a serde_json::Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_default()
}

/// One side of a formula: a column, or a typed literal.
fn operand_sql(operand: &serde_json::Value) -> Option<String> {
    if operand.is_null() {
        return None;
    }
    if operand["kind"] == "Attribute" {
        let c = spec_str(operand, "column");
        return (!c.is_empty()).then(|| crate::qid(c));
    }
    let kind = operand["type"].as_str().filter(|t| !t.is_empty()).unwrap_or("Number");
    literal_sql(spec_str(operand, "value"), kind)
}

/// A value spec as SQL, None when not filled in yet (valuespec.js `valueSql`).
fn value_sql(spec: &serde_json::Value) -> Option<String> {
    if !spec.is_object() {
        return None;
    }
    match spec["kind"].as_str().filter(|k| !k.is_empty()).unwrap_or("Value") {
        "Attribute" => {
            let c = spec_str(spec, "column");
            (!c.is_empty()).then(|| crate::qid(c))
        }
        "Formula" => {
            let (l, r) = (operand_sql(&spec["left"])?, operand_sql(&spec["right"])?);
            let op = spec["operator"].as_str().filter(|o| !o.is_empty()).unwrap_or("+");
            let sql = match op {
                "+" => format!("{l} + {r}"),
                "-" => format!("{l} - {r}"),
                "×" => format!("{l} * {r}"),
                // Division by zero is a missing answer, not a crash.
                "÷" => format!("{l} / NULLIF({r}, 0)"),
                "join text" => format!("{l} || {r}"),
                _ => return None,
            };
            Some(format!("({sql})"))
        }
        "SQL" => {
            let s = spec_str(spec, "sql").trim();
            (!s.is_empty()).then(|| crate::sqlguard::splice_expression(s))
        }
        _ => {
            let kind = spec["type"].as_str().filter(|t| !t.is_empty()).unwrap_or("Text");
            literal_sql(spec_str(spec, "value"), kind)
        }
    }
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
