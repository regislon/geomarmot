//! Row-list editors for the parameter form: renames, sorts, new attributes (value specs) and
//! AttributeManager's edits, as the JavaScript inspector's `renames`/`sorts`/`valuerows`/`actions`.

use egui::Ui;
use geomarmot_core::{Cell, Kind};
use serde_json::{Value, json};

use crate::form::column_picker;

type Id = (usize, &'static str);

/// A text field bound to `row[key]`.
fn text(ui: &mut Ui, row: &mut Value, key: &str, hint: &str, width: f32) -> bool {
    let mut s = row[key].as_str().unwrap_or_default().to_string();
    let changed = ui
        .add(egui::TextEdit::singleline(&mut s).hint_text(hint).desired_width(width))
        .changed();
    if changed {
        row[key] = Value::String(s);
    }
    changed
}

/// An attribute of the input bound to `row[key]`: a picker once the input has run, else text.
fn column(
    ui: &mut Ui,
    id: impl std::hash::Hash + std::fmt::Debug,
    row: &mut Value,
    key: &str,
    names: Option<&Vec<String>>,
) -> bool {
    let Some(names) = names else {
        return text(ui, row, key, "attribute", 110.0);
    };
    let mut s = row[key].as_str().unwrap_or_default().to_string();
    // Narrower than the inspector's picker: it sits in a row beside other fields.
    let changed = ui
        .scope(|ui| {
            ui.set_max_width(120.0);
            column_picker(ui, id, &mut s, names)
        })
        .inner;
    if changed {
        row[key] = Value::String(s);
    }
    changed
}

/// One of `options` bound to `row[key]`, `default` when unset.
pub(crate) fn choice(
    ui: &mut Ui,
    id: impl std::hash::Hash + std::fmt::Debug,
    row: &mut Value,
    key: &str,
    options: &[&str],
    default: &str,
) -> bool {
    let mut s = row[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(default)
        .to_string();
    let before = s.clone();
    egui::ComboBox::from_id_salt(id).selected_text(&s).show_ui(ui, |ui| {
        for o in options {
            ui.selectable_value(&mut s, o.to_string(), *o);
        }
    });
    let changed = s != before;
    if changed {
        row[key] = Value::String(s);
    }
    changed
}

/// A typed literal or an attribute: one side of a formula, or a whole Value spec.
fn literal(ui: &mut Ui, id: impl std::hash::Hash + Copy + std::fmt::Debug, v: &mut Value, default_type: &str) -> bool {
    let mut c = choice(
        ui,
        (id, "type"),
        v,
        "type",
        &["Text", "Number", "Boolean", "Null"],
        default_type,
    );
    if v["type"] != "Null" {
        c |= text(ui, v, "value", "value", 90.0);
    }
    c
}

/// A value spec (valuespec.js): a constant, an attribute, a formula or SQL.
pub(crate) fn spec(
    ui: &mut Ui,
    id: impl std::hash::Hash + Copy + std::fmt::Debug,
    v: &mut Value,
    names: Option<&Vec<String>>,
) -> bool {
    if !v.is_object() {
        *v = json!({ "kind": "Value", "type": "Text", "value": "" });
    }
    let mut c = choice(
        ui,
        (id, "kind"),
        v,
        "kind",
        &["Value", "Attribute", "Formula", "SQL"],
        "Value",
    );
    match v["kind"].as_str().unwrap_or("Value") {
        "Attribute" => c |= column(ui, (id, "col"), v, "column", names),
        "Formula" => {
            for (side, default) in [("left", "Attribute"), ("right", "Value")] {
                if !v[side].is_object() {
                    v[side] = json!({ "kind": default, "type": "Number" });
                }
                let o = &mut v[side];
                c |= choice(ui, (id, side, "k"), o, "kind", &["Attribute", "Value"], default);
                if o["kind"] == "Attribute" {
                    c |= column(ui, (id, side), o, "column", names);
                } else {
                    c |= literal(ui, (id, side), o, "Number");
                }
                if side == "left" {
                    c |= choice(ui, (id, "op"), v, "operator", &["+", "-", "×", "÷", "join text"], "+");
                }
            }
        }
        "SQL" => c |= text(ui, v, "sql", "SQL expression", 200.0),
        _ => c |= literal(ui, id, v, "Text"),
    }
    c
}

const ACTIONS: &[&str] = &["Set value", "Rename", "Copy to", "Create", "Convert", "Remove"];
pub(crate) const CONVERT: &[&str] = &["Text", "Integer", "Decimal", "Boolean", "Date", "Date and time"];

/// One row of a list kind; true when it changed.
fn row(ui: &mut Ui, kind: Kind, id: (Id, usize), r: &mut Value, names: Option<&Vec<String>>) -> bool {
    match kind {
        Kind::Renames => {
            let c = column(ui, (id, "from"), r, "from", names);
            ui.label("→");
            c | text(ui, r, "to", "new name", 110.0)
        }
        Kind::Sorts => {
            column(ui, (id, "col"), r, "column", names) | choice(ui, id, r, "direction", &["ASC", "DESC"], "ASC")
        }
        Kind::ValueRows => {
            let c = text(ui, r, "name", "name", 90.0);
            ui.label("=");
            c | spec(ui, id, &mut r["value"], names)
        }
        Kind::Actions => {
            let mut c = choice(ui, (id, "a"), r, "action", ACTIONS, "Set value");
            let action = r["action"].as_str().unwrap_or("Set value").to_string();
            if action != "Create" {
                c |= column(ui, (id, "col"), r, "column", names);
            }
            match action.as_str() {
                "Rename" | "Copy to" | "Create" => c |= text(ui, r, "target", "new name", 90.0),
                "Convert" => c |= choice(ui, (id, "to"), r, "to", CONVERT, "Text"),
                _ => {}
            }
            if matches!(action.as_str(), "Set value" | "Create") {
                c |= spec(ui, id, &mut r["spec"], names);
            }
            c
        }
        _ => false,
    }
}

/// A list of rows with remove and add buttons; true when it changed.
pub fn show(ui: &mut Ui, id: Id, kind: Kind, value: &mut Value, names: Option<&Vec<String>>) -> bool {
    let mut rows = value.as_array().cloned().unwrap_or_default();
    let mut changed = false;
    let mut remove = None;
    for (i, r) in rows.iter_mut().enumerate() {
        if !r.is_object() {
            *r = json!({});
        }
        ui.horizontal_wrapped(|ui| {
            changed |= row(ui, kind, (id, i), r, names);
            if ui.small_button("×").on_hover_text("Remove").clicked() {
                remove = Some(i);
            }
        });
    }
    if let Some(i) = remove {
        rows.remove(i);
        changed = true;
    }
    if ui.small_button("+ Add").clicked() {
        rows.push(json!({}));
        changed = true;
    }
    if names.is_none() {
        ui.label(egui::RichText::new("Run the input to pick from its attributes.").small());
    }
    if changed {
        *value = Value::Array(rows);
    }
    changed
}

/// Column title of a row field.
fn title(key: &str) -> &str {
    match key {
        "label" => "Output port",
        "column" => "Attribute",
        "operator" => "Operator",
        "value" => "Value",
        "func" => "Function",
        "alias" => "Result name",
        other => other,
    }
}

/// A list of rows as a table: a header, then one line per row (conditions, rules, aggregates).
pub fn table(
    ui: &mut Ui,
    id: Id,
    fields: &[(&'static str, Cell)],
    value: &mut Value,
    names: Option<&Vec<String>>,
) -> bool {
    const WIDTH: f32 = 104.0;
    let mut rows: Vec<Value> = value.as_array().cloned().unwrap_or_default();
    let (mut changed, mut remove) = (false, None);
    let pick = |ui: &mut Ui, salt, s: &mut String, options: &mut dyn Iterator<Item = &str>| {
        let before = s.clone();
        egui::ComboBox::from_id_salt(salt)
            .width(WIDTH)
            .selected_text(if s.is_empty() { "—" } else { s.as_str() })
            .show_ui(ui, |ui| {
                for o in options {
                    ui.selectable_value(s, o.to_string(), o);
                }
            });
        *s != before
    };
    egui::Grid::new(("rows", id))
        .num_columns(fields.len() + 1)
        .spacing([6.0, 4.0])
        .striped(true)
        .show(ui, |ui| {
            for (key, _) in fields {
                ui.label(egui::RichText::new(title(key)).small().strong());
            }
            ui.end_row();
            for (i, row) in rows.iter_mut().enumerate() {
                for (key, cell) in fields {
                    let mut s = row[*key]
                        .as_str()
                        .map(String::from)
                        .unwrap_or_else(|| match &row[*key] {
                            Value::Null => String::new(),
                            v => v.to_string(),
                        });
                    let edited = match (cell, names) {
                        (Cell::Column, Some(names)) => pick(
                            ui,
                            (id, i, *key),
                            &mut s,
                            &mut std::iter::once("").chain(names.iter().map(String::as_str)),
                        ),
                        (Cell::Pick(options), _) => pick(ui, (id, i, *key), &mut s, &mut options.iter().copied()),
                        // An empty rule label leaves the port its default name, R0, R1, …
                        _ => {
                            let hint = if *key == "label" {
                                format!("R{i}")
                            } else {
                                title(key).to_lowercase()
                            };
                            ui.add_sized([WIDTH, 20.0], egui::TextEdit::singleline(&mut s).hint_text(hint))
                                .changed()
                        }
                    };
                    if edited {
                        row[*key] = Value::String(s);
                        changed = true;
                    }
                }
                if ui.small_button("×").on_hover_text("Remove").clicked() {
                    remove = Some(i);
                }
                ui.end_row();
            }
        });
    if let Some(i) = remove {
        rows.remove(i);
        changed = true;
    }
    if ui.small_button("+ Add").clicked() {
        rows.push(Value::Object(
            fields.iter().map(|(k, _)| (k.to_string(), Value::from(""))).collect(),
        ));
        changed = true;
    }
    if changed {
        *value = Value::Array(rows);
    }
    changed
}
