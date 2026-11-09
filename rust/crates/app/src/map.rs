//! A plain map: the selected port's geometry, fitted to the panel. No basemap yet.
// ponytail: no basemap (walkers) and no pan/zoom yet; add with the UI phase, keeping tiles optional offline (ADR 0008).

use egui::{Color32, Pos2, Shape, Stroke, Ui};
use serde_json::Value;

fn each_position(g: &Value, f: &mut dyn FnMut(f64, f64)) {
    match g.get("coordinates") {
        Some(c) => walk(c, f),
        None => g
            .get("geometries")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .for_each(|g| each_position(g, f)),
    }
}

fn walk(c: &Value, f: &mut dyn FnMut(f64, f64)) {
    let Some(a) = c.as_array() else { return };
    if let (Some(x), Some(y)) = (a.first().and_then(Value::as_f64), a.get(1).and_then(Value::as_f64)) {
        f(x, y);
    } else {
        a.iter().for_each(|c| walk(c, f));
    }
}

/// The rings or lines of a GeoJSON geometry, as lists of positions.
fn paths(g: &Value) -> Vec<Vec<(f64, f64)>> {
    fn collect(c: &Value, depth: usize, out: &mut Vec<Vec<(f64, f64)>>) {
        let Some(a) = c.as_array() else { return };
        if depth == 1 {
            out.push(
                a.iter()
                    .filter_map(|p| Some((p.get(0)?.as_f64()?, p.get(1)?.as_f64()?)))
                    .collect(),
            );
        } else {
            a.iter().for_each(|c| collect(c, depth - 1, out));
        }
    }
    let mut out = Vec::new();
    let depth = match g.get("type").and_then(Value::as_str) {
        Some("LineString" | "MultiPoint") => 1,
        Some("Polygon" | "MultiLineString") => 2,
        Some("MultiPolygon") => 3,
        Some("GeometryCollection") => {
            g["geometries"]
                .as_array()
                .into_iter()
                .flatten()
                .for_each(|g| out.extend(paths(g)));
            return out;
        }
        _ => return out,
    };
    collect(&g["coordinates"], depth, &mut out);
    out
}

pub fn show(ui: &mut Ui, shapes: &[Value]) {
    let (response, painter) = ui.allocate_painter(ui.available_size(), egui::Sense::hover());
    let area = response.rect.shrink(12.0);
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for g in shapes {
        each_position(g, &mut |x, y| {
            (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y))
        });
    }
    if !x0.is_finite() {
        painter.text(
            area.center(),
            egui::Align2::CENTER_CENTER,
            "No geometry",
            Default::default(),
            Color32::GRAY,
        );
        return;
    }
    let span = (x1 - x0).max(y1 - y0).max(1e-12);
    let scale = (area.width().min(area.height()) as f64) / span;
    let to_screen = |x: f64, y: f64| {
        Pos2::new(
            area.left() + ((x - x0) * scale) as f32,
            area.bottom() - ((y - y0) * scale) as f32,
        )
    };
    let stroke = Stroke::new(1.0, Color32::from_rgb(40, 110, 170));
    for g in shapes {
        if g.get("type").and_then(Value::as_str) == Some("Point") {
            each_position(g, &mut |x, y| {
                painter.circle_filled(to_screen(x, y), 3.0, stroke.color);
            });
            continue;
        }
        for path in paths(g) {
            painter.add(Shape::line(
                path.iter().map(|&(x, y)| to_screen(x, y)).collect(),
                stroke,
            ));
        }
    }
}
