//! The parameter editor, drawn from a transformer's `params()` as the JavaScript inspector
//! draws from its `params` declaration (app/src/ui/inspector). Attribute pickers list the real
//! attributes of the input they read; until that input has run, they fall back to text.

use std::collections::BTreeMap;

use egui::{RichText, Ui};
use geomarmot_core::{Kind, Param};
use serde_json::{Value, json};

use crate::canvas::colour;

/// Attribute names per input port, when that input has run.
pub type Columns = BTreeMap<String, Vec<String>>;

/// What the form asks the app to do.
#[derive(Default)]
pub struct Outcome {
    pub changed: bool,
    /// "Fill from data" on a values list: fill `values` with the distinct values of `column`.
    pub fill: Option<(&'static str, String)>,
}

fn muted(text: impl Into<String>) -> RichText {
    RichText::new(text.into()).small().color(colour::MUTED)
}

fn text(v: &Value, default: &str) -> String {
    v.as_str().map(String::from).unwrap_or_else(|| default.to_string())
}

/// A dropdown of attribute names, with "—" for none.
fn column_picker(
    ui: &mut Ui,
    id: impl std::hash::Hash + std::fmt::Debug,
    current: &mut String,
    names: &[String],
) -> bool {
    let before = current.clone();
    egui::ComboBox::from_id_salt(id)
        .width(ui.available_width().min(260.0))
        .selected_text(if current.is_empty() { "—" } else { current.as_str() })
        .show_ui(ui, |ui| {
            ui.selectable_value(current, String::new(), "—");
            for name in names {
                ui.selectable_value(current, name.clone(), name);
            }
        });
    *current != before
}

/// A small dropdown over fixed choices.
fn choice(ui: &mut Ui, id: impl std::hash::Hash + std::fmt::Debug, current: &mut String, options: &[&str]) -> bool {
    let before = current.clone();
    egui::ComboBox::from_id_salt(id)
        .selected_text(current.as_str())
        .show_ui(ui, |ui| {
            for o in options {
                ui.selectable_value(current, o.to_string(), *o);
            }
        });
    *current != before
}

/// Edit `spec[key]` as a string with `f`; true when it changed.
fn edit(spec: &mut Value, key: &str, f: impl FnOnce(&mut String) -> bool) -> bool {
    let mut s = text(&spec[key], "");
    let changed = f(&mut s);
    if changed {
        spec[key] = Value::String(s);
    }
    changed
}

/// A value spec (app/src/core/valuespec.js): a constant, an attribute, a formula or SQL.
fn value_spec(ui: &mut Ui, id: (usize, &str), spec: &mut Value, names: &[String]) -> bool {
    let attribute = |ui: &mut Ui, salt: &str, s: &mut String| {
        if names.is_empty() {
            ui.text_edit_singleline(s).changed()
        } else {
            column_picker(ui, (id, salt), s, names)
        }
    };
    let kinds = ["Value", "Attribute", "Formula", "SQL"];
    let mut changed = edit(spec, "kind", |s| choice(ui, (id, "kind"), s, &kinds));
    match spec["kind"].as_str().unwrap_or("Value") {
        "Attribute" => changed |= edit(spec, "column", |s| attribute(ui, "column", s)),
        "SQL" => changed |= edit(spec, "sql", |s| ui.text_edit_multiline(s).changed()),
        "Formula" => {
            for side in ["left", "right"] {
                if !spec[side].is_object() {
                    spec[side] = json!({ "kind": "Attribute", "type": "Number", "column": "", "value": "" });
                }
                let operand = &mut spec[side];
                ui.horizontal(|ui| {
                    changed |= edit(operand, "kind", |s| choice(ui, (id, side), s, &["Attribute", "Value"]));
                    changed |= if operand["kind"] == "Attribute" {
                        edit(operand, "column", |s| attribute(ui, side, s))
                    } else {
                        edit(operand, "value", |s| ui.text_edit_singleline(s).changed())
                    };
                });
                if side == "left" {
                    let operators = ["+", "-", "×", "÷", "join text"];
                    changed |= edit(spec, "operator", |s| choice(ui, (id, "op"), s, &operators));
                }
            }
        }
        _ => {
            ui.horizontal(|ui| {
                let types = ["Text", "Number", "Boolean", "Null"];
                changed |= edit(spec, "type", |s| choice(ui, (id, "type"), s, &types));
                changed |= edit(spec, "value", |s| ui.text_edit_singleline(s).changed());
            });
        }
    }
    changed
}

pub fn show(ui: &mut Ui, node: usize, params: &[Param], values: &mut Value, columns: &Columns) -> Outcome {
    let mut out = Outcome::default();
    if !values.is_object() {
        *values = json!({});
    }
    for p in params {
        let id = (node, p.id);
        ui.add_space(8.0);
        ui.label(RichText::new(p.label).strong()).on_hover_text(p.description);
        let fill_column = text(&values["column"], "");
        let value = values
            .as_object_mut()
            .expect("an object")
            .entry(p.id)
            .or_insert(Value::Null);
        match p.kind {
            Kind::String { placeholder, units } => {
                let mut s = text(value, p.default);
                ui.horizontal(|ui| {
                    let width = ui.available_width() - if units.is_empty() { 0.0 } else { 24.0 };
                    if ui
                        .add(
                            egui::TextEdit::singleline(&mut s)
                                .hint_text(placeholder)
                                .desired_width(width),
                        )
                        .changed()
                    {
                        *value = Value::String(s.clone());
                        out.changed = true;
                    }
                    if !units.is_empty() {
                        ui.label(muted(units));
                    }
                });
            }
            Kind::Select(options) => {
                let mut s = text(value, p.default);
                let before = s.clone();
                egui::ComboBox::from_id_salt(id)
                    .width(ui.available_width().min(260.0))
                    .selected_text(&s)
                    .show_ui(ui, |ui| {
                        for (v, description) in options {
                            ui.selectable_value(&mut s, v.to_string(), *v)
                                .on_hover_text(*description);
                        }
                    });
                if let Some((_, d)) = options.iter().find(|(v, _)| *v == s) {
                    ui.label(muted(*d));
                }
                if s != before {
                    *value = Value::String(s);
                    out.changed = true;
                }
            }
            Kind::Column { port } => {
                let mut s = text(value, "");
                let changed = match columns.get(port) {
                    Some(names) => column_picker(ui, id, &mut s, names),
                    None => {
                        let c = ui.text_edit_singleline(&mut s).changed();
                        ui.label(muted("Run the input to pick from its attributes."));
                        c
                    }
                };
                if changed {
                    *value = Value::String(s);
                    out.changed = true;
                }
            }
            Kind::Columns { port } => {
                let mut chosen: Vec<String> = value
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect();
                match columns.get(port) {
                    Some(names) => {
                        let filter_id = ui.id().with(("filter", id));
                        let mut filter: String = ui.data_mut(|d| d.get_temp(filter_id).unwrap_or_default());
                        let mut changed = false;
                        ui.horizontal(|ui| {
                            if names.len() > 6 {
                                ui.add(
                                    egui::TextEdit::singleline(&mut filter)
                                        .hint_text("Filter")
                                        .desired_width(120.0),
                                );
                            }
                            if ui.small_button("All").clicked() {
                                chosen = names.clone();
                                changed = true;
                            }
                            if ui.small_button("None").clicked() {
                                chosen.clear();
                                changed = true;
                            }
                            ui.label(muted(format!("{} of {}", chosen.len(), names.len())));
                        });
                        ui.data_mut(|d| d.insert_temp(filter_id, filter.clone()));
                        egui::ScrollArea::vertical()
                            .id_salt(id)
                            .max_height(170.0)
                            .show(ui, |ui| {
                                let f = filter.to_lowercase();
                                for name in names.iter().filter(|n| n.to_lowercase().contains(&f)) {
                                    let mut on = chosen.contains(name);
                                    if ui.checkbox(&mut on, name).changed() {
                                        changed = true;
                                        if on {
                                            chosen.push(name.clone());
                                        } else {
                                            chosen.retain(|c| c != name);
                                        }
                                    }
                                }
                            });
                        if changed {
                            // The input's order, not the click order (as the JavaScript editor).
                            let picked: Vec<Value> = names
                                .iter()
                                .filter(|n| chosen.contains(n))
                                .map(|n| Value::String(n.clone()))
                                .collect();
                            *value = Value::Array(picked);
                            out.changed = true;
                        }
                    }
                    None => {
                        ui.label(if chosen.is_empty() {
                            muted("None chosen.")
                        } else {
                            RichText::new(chosen.join(", "))
                        });
                        ui.label(muted("Run the input to pick from its attributes."));
                    }
                }
            }
            Kind::Choices { choices, default } => {
                let mut chosen: Vec<String> = match value.as_array() {
                    Some(a) => a.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
                    None => default.iter().map(|s| s.to_string()).collect(),
                };
                let mut changed = false;
                for c in choices {
                    let mut on = chosen.iter().any(|x| x == c);
                    if ui.checkbox(&mut on, *c).changed() {
                        changed = true;
                        chosen.retain(|x| x != c);
                        if on {
                            chosen.push(c.to_string());
                        }
                    }
                }
                if changed {
                    // The declared order, not the click order.
                    let picked = choices.iter().filter(|c| chosen.iter().any(|x| x == *c));
                    *value = picked.map(|c| Value::String(c.to_string())).collect();
                    out.changed = true;
                }
            }
            Kind::Values => {
                let mut items: Vec<String> = value.as_array().into_iter().flatten().map(|v| text(v, "")).collect();
                let mut changed = false;
                let mut remove = None;
                for (i, item) in items.iter_mut().enumerate() {
                    ui.horizontal(|ui| {
                        changed |= ui
                            .add(egui::TextEdit::singleline(item).hint_text("value").desired_width(200.0))
                            .changed();
                        if ui.small_button("×").on_hover_text("Remove").clicked() {
                            remove = Some(i);
                        }
                    });
                }
                if let Some(i) = remove {
                    items.remove(i);
                    changed = true;
                }
                if ui.small_button("+ Add value").clicked() {
                    items.push(String::new());
                    changed = true;
                }
                if changed {
                    *value = Value::Array(items.into_iter().map(Value::String).collect());
                    out.changed = true;
                }
                // Fill from the distinct values of the `column` parameter, as the JavaScript editor.
                let column = fill_column.clone();
                if ui
                    .add_enabled(!column.is_empty(), egui::Button::new("Fill from data").small())
                    .on_hover_text("Replace the list with the attribute's distinct values")
                    .on_disabled_hover_text("Choose the attribute first")
                    .clicked()
                {
                    out.fill = Some((p.id, column));
                }
            }
            Kind::ValueSpec => {
                if !value.is_object() {
                    *value = json!({ "kind": "Value", "type": "Number", "value": "" });
                }
                let names = columns.get("input").map(Vec::as_slice).unwrap_or_default();
                out.changed |= value_spec(ui, id, value, names);
            }
            Kind::JoinKeys => {
                let mut rows: Vec<(String, String)> = value
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|r| (text(&r["left"], ""), text(&r["right"], "")))
                    .collect();
                let (left, right) = (columns.get("left"), columns.get("right"));
                let mut changed = false;
                let mut remove = None;
                for (i, (l, r)) in rows.iter_mut().enumerate() {
                    ui.horizontal(|ui| {
                        changed |= match left {
                            Some(names) => column_picker(ui, (id, i, "l"), l, names),
                            None => ui.add(egui::TextEdit::singleline(l).desired_width(110.0)).changed(),
                        };
                        ui.label("=");
                        changed |= match right {
                            Some(names) => column_picker(ui, (id, i, "r"), r, names),
                            None => ui.add(egui::TextEdit::singleline(r).desired_width(110.0)).changed(),
                        };
                        if ui.small_button("×").on_hover_text("Remove").clicked() {
                            remove = Some(i);
                        }
                    });
                }
                if let Some(i) = remove {
                    rows.remove(i);
                    changed = true;
                }
                if ui.small_button("+ Add pair").clicked() {
                    rows.push(Default::default());
                    changed = true;
                }
                if left.is_none() || right.is_none() {
                    ui.label(muted("Connect and run both inputs to choose attributes."));
                }
                if changed {
                    *value = Value::Array(
                        rows.into_iter()
                            .map(|(l, r)| json!({ "left": l, "right": r }))
                            .collect(),
                    );
                    out.changed = true;
                }
            }
        }
    }
    out
}
