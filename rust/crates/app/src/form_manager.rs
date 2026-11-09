//! AttributeManager as a table: one line per input attribute (its output name, value and action),
//! then the attributes it creates or copies. The node still stores its ordered edit list
//! (`actions`); the table reads that list and writes it back in a fixed order.

use egui::{RichText, Ui};
use serde_json::{Value, json};

use crate::canvas::colour;
use crate::form_rows::{CONVERT, choice, spec};

/// One line of the table. `input` is None for a created attribute.
#[derive(Debug, Clone, PartialEq)]
struct Line {
    input: Option<String>,
    output: String,
    /// Keep, Set value, Convert or Remove for an input attribute; Create or Copy to otherwise.
    action: String,
    to: String,
    spec: Value,
    extra: bool,
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}

/// The edit list as table lines, plus the edits the table cannot show (kept as they are).
fn parse(actions: &[Value], names: &[String]) -> (Vec<Line>, Vec<Value>) {
    let mut lines: Vec<Line> = names
        .iter()
        .map(|n| Line {
            input: Some(n.clone()),
            output: n.clone(),
            action: "Keep".into(),
            to: "Text".into(),
            spec: Value::Null,
            extra: false,
        })
        .collect();
    let mut other = Vec::new();
    for a in actions {
        let column = s(a, "column");
        let at = lines
            .iter()
            .position(|l| !l.extra && l.input.as_deref() == Some(column));
        match (s(a, "action"), at) {
            ("Rename", Some(i)) if !s(a, "target").is_empty() => lines[i].output = s(a, "target").into(),
            ("Remove", Some(i)) => lines[i].action = "Remove".into(),
            ("Set value", Some(i)) => {
                lines[i].action = "Set value".into();
                lines[i].spec = a["spec"].clone();
            }
            ("Convert", Some(i)) => {
                lines[i].action = "Convert".into();
                lines[i].to = s(a, "to").into();
            }
            ("Copy to", Some(_)) | ("Create", _) => lines.push(Line {
                input: (s(a, "action") == "Copy to").then(|| column.to_string()),
                output: s(a, "target").into(),
                action: s(a, "action").into(),
                to: String::new(),
                spec: a["spec"].clone(),
                extra: true,
            }),
            _ => other.push(a.clone()),
        }
    }
    (lines, other)
}

/// Table lines back to an edit list: values and conversions, then copies and new attributes,
/// then renames and removals (so values and copies still see the input's names).
fn serialize(lines: &[Line], other: &[Value]) -> Vec<Value> {
    let mut out = other.to_vec();
    for l in lines.iter().filter(|l| !l.extra) {
        let c = l.input.clone().unwrap_or_default();
        match l.action.as_str() {
            "Set value" => out.push(json!({ "action": "Set value", "column": c, "spec": l.spec })),
            "Convert" => out.push(json!({ "action": "Convert", "column": c, "to": l.to })),
            _ => {}
        }
    }
    for l in lines.iter().filter(|l| l.extra) {
        out.push(match l.input.as_deref() {
            Some(c) => json!({ "action": "Copy to", "column": c, "target": l.output }),
            None => json!({ "action": "Create", "target": l.output, "spec": l.spec }),
        });
    }
    for l in lines.iter().filter(|l| !l.extra) {
        let c = l.input.clone().unwrap_or_default();
        if l.action == "Remove" {
            out.push(json!({ "action": "Remove", "column": c }));
        } else if !l.output.is_empty() && l.output != c {
            out.push(json!({ "action": "Rename", "column": c, "target": l.output }));
        }
    }
    out
}

/// Draw the table; true when the edit list changed.
pub fn table(ui: &mut Ui, id: (usize, &'static str), value: &mut Value, names: &[String]) -> bool {
    const W: f32 = 130.0;
    let actions = value.as_array().cloned().unwrap_or_default();
    let (mut lines, other) = parse(&actions, names);
    let before = lines.clone();
    let mut remove = None;
    let muted = |t: &str| RichText::new(t).small().color(colour::MUTED);
    egui::Grid::new(("manager", id))
        .num_columns(5)
        .spacing([6.0, 4.0])
        .striped(true)
        .show(ui, |ui| {
            for h in ["Input attribute", "Output attribute", "Action", "Value", ""] {
                ui.label(RichText::new(h).small().strong());
            }
            ui.end_row();
            for (i, l) in lines.iter_mut().enumerate() {
                let removed = l.action == "Remove";
                match (&mut l.input, l.extra) {
                    (Some(c), true) => {
                        let mut row = json!({ "c": c.clone() });
                        if choice(
                            ui,
                            (id, i, "in"),
                            &mut row,
                            "c",
                            &names.iter().map(String::as_str).collect::<Vec<_>>(),
                            "",
                        ) {
                            *c = s(&row, "c").into();
                        }
                    }
                    (Some(c), false) => {
                        let text = RichText::new(c.as_str());
                        ui.label(if removed {
                            text.strikethrough().color(colour::MUTED)
                        } else {
                            text
                        });
                    }
                    (None, _) => {
                        ui.label(muted("new"));
                    }
                }
                ui.add_enabled_ui(!removed, |ui| {
                    ui.add_sized([W, 20.0], egui::TextEdit::singleline(&mut l.output))
                });
                let options: &[&str] = if l.extra {
                    &[]
                } else {
                    &["Keep", "Set value", "Convert", "Remove"]
                };
                if options.is_empty() {
                    ui.label(muted(&l.action));
                } else {
                    let mut row = json!({ "a": l.action });
                    if choice(ui, (id, i, "act"), &mut row, "a", options, "Keep") {
                        l.action = s(&row, "a").into();
                    }
                }
                ui.horizontal_wrapped(|ui| {
                    // A formula wraps onto a second line rather than pushing the table off screen.
                    ui.set_max_width(460.0);
                    match l.action.as_str() {
                        "Set value" | "Create" => {
                            spec(ui, (id, i), &mut l.spec, Some(&names.to_vec()));
                        }
                        "Convert" => {
                            let mut row = json!({ "to": l.to });
                            if choice(ui, (id, i, "to"), &mut row, "to", CONVERT, "Text") {
                                l.to = s(&row, "to").into();
                            }
                        }
                        "Copy to" => {
                            ui.label(muted("copy of the input"));
                        }
                        _ => {
                            ui.label(muted(if removed { "removed" } else { "unchanged" }));
                        }
                    }
                });
                if l.extra && ui.small_button("×").on_hover_text("Remove this line").clicked() {
                    remove = Some(i);
                }
                ui.end_row();
            }
        });
    if let Some(i) = remove {
        lines.remove(i);
    }
    ui.horizontal(|ui| {
        let new = |input: Option<String>, action: &str| Line {
            input,
            output: String::new(),
            action: action.into(),
            to: String::new(),
            spec: Value::Null,
            extra: true,
        };
        if ui.small_button("+ New attribute").clicked() {
            lines.push(new(None, "Create"));
        }
        if ui.small_button("+ Copy an attribute").clicked() {
            lines.push(new(names.first().cloned(), "Copy to"));
        }
    });
    let changed = lines != before;
    if changed {
        *value = Value::Array(serialize(&lines, &other));
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_round_trips_the_edit_list() {
        let names = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let actions = vec![
            json!({ "action": "Set value", "column": "a", "spec": { "kind": "Value", "value": "1" } }),
            json!({ "action": "Convert", "column": "b", "to": "Integer" }),
            json!({ "action": "Copy to", "column": "a", "target": "a2" }),
            json!({ "action": "Create", "target": "d", "spec": { "kind": "Value", "value": "x" } }),
            json!({ "action": "Rename", "column": "a", "target": "alpha" }),
            json!({ "action": "Remove", "column": "c" }),
        ];
        let (lines, other) = parse(&actions, &names);
        assert!(other.is_empty());
        assert_eq!(lines[0].output, "alpha");
        assert_eq!(lines[2].action, "Remove");
        assert_eq!(serialize(&lines, &other), actions);
    }
}
