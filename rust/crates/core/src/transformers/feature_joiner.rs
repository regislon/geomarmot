use std::collections::HashSet;

use crate::{Ctx, Kind, Param, Ports, Result, Transformer, qid};
use serde_json::Value;

pub struct FeatureJoiner;

impl Transformer for FeatureJoiner {
    fn id(&self) -> &'static str {
        "FeatureJoiner"
    }

    fn summary(&self) -> &'static str {
        "Joins two streams on matching attributes, with the unmatched rows on their own ports."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[
            Param::new(
                "joinType",
                "Join",
                Kind::Select(&[
                    ("Inner", "Joined holds matched rows only."),
                    ("Left", "Joined keeps every left row, with NULLs where nothing matched."),
                    ("Full", "Joined keeps every row of both sides."),
                ]),
                "Which rows the Joined port keeps when a row finds no partner on the other side.",
            )
            .default("Inner"),
            Param::new(
                "keys",
                "Join on",
                Kind::JoinKeys,
                "Pairs of left and right attributes that must be equal for two rows to match.",
            ),
            Param::new(
                "suffix",
                "Suffix for clashing right attributes",
                Kind::String {
                    placeholder: "",
                    units: "",
                },
                "Appended to a right attribute whose name the left side already has, so both can be kept.",
            )
            .default("_right"),
        ];
        P
    }

    fn inputs(&self) -> &'static [&'static str] {
        &["left", "right"]
    }

    fn outputs(&self, _params: &Value) -> Vec<String> {
        vec!["joined".into(), "unjoinedLeft".into(), "unjoinedRight".into()]
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let pairs: Vec<(String, String)> = ctx
            .params
            .get("keys")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|p| {
                let l = p.get("left")?.as_str().filter(|s| !s.is_empty())?;
                let r = p.get("right")?.as_str().filter(|s| !s.is_empty())?;
                Some((l.to_string(), r.to_string()))
            })
            .collect();
        if pairs.is_empty() {
            return Err("FeatureJoiner needs at least one pair of join attributes.".into());
        }
        let (left, right) = (ctx.input("left"), ctx.input("right"));
        let condition: Vec<String> = pairs
            .iter()
            .map(|(l, r)| format!("l.{} = r.{}", qid(l), qid(r)))
            .collect();
        let condition = condition.join(" AND ");
        let right_keys: HashSet<&str> = pairs.iter().map(|(_, r)| r.as_str()).collect();
        let left_names: HashSet<&str> = ctx.schema("left").iter().map(|c| c.name.as_str()).collect();
        let suffix = Some(ctx.str("suffix")).filter(|s| !s.is_empty()).unwrap_or("_right");
        let mut selection = vec!["l.*".to_string()];
        for c in ctx
            .schema("right")
            .iter()
            .filter(|c| !right_keys.contains(c.name.as_str()))
        {
            selection.push(if left_names.contains(c.name.as_str()) {
                format!("r.{} AS {}", qid(&c.name), qid(&format!("{}{suffix}", c.name)))
            } else {
                format!("r.{}", qid(&c.name))
            });
        }
        let join = match ctx.str("joinType") {
            "Left" => "LEFT JOIN",
            "Full" => "FULL JOIN",
            _ => "INNER JOIN",
        };
        let (l0, r0) = (qid(&pairs[0].0), qid(&pairs[0].1));
        Ok(Ports::from([
            (
                "joined".into(),
                format!(
                    "SELECT {} FROM {left} l {join} {right} r ON {condition}",
                    selection.join(", ")
                ),
            ),
            (
                "unjoinedLeft".into(),
                format!("SELECT l.* FROM {left} l LEFT JOIN {right} r ON {condition} WHERE r.{r0} IS NULL"),
            ),
            (
                "unjoinedRight".into(),
                format!("SELECT r.* FROM {right} r LEFT JOIN {left} l ON {condition} WHERE l.{l0} IS NULL"),
            ),
        ]))
    }
}
