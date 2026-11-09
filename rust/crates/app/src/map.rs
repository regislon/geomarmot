//! The geometry map: an OpenStreetMap background (the JavaScript app's default "Street"),
//! drag to pan, wheel to zoom at the pointer, double-click or "Fit" to the data.
//! Features arrive as GeoJSON in longitude/latitude with their row id; the selected row's
//! feature is highlighted, and `zoom_to` frames one feature.

use egui::{Color32, Pos2, Rect, Shape, Stroke, Ui, Vec2};
use serde_json::Value;

use crate::canvas::colour;

const TILE: f64 = 256.0;
const TILES: &str = "https://tile.openstreetmap.org";
/// Points drawn per frame at most; egui's vertex buffer has a hard size limit.
const MAX_VERTICES: usize = 400_000;
/// Features smaller than this on screen (pixels) are drawn as dots, so they stay visible.
const DOT_BELOW: f32 = 5.0;

/// Longitude/latitude to Web Mercator, as 0..1 across the world.
fn mercator(lon: f64, lat: f64) -> (f64, f64) {
    let lat = lat.clamp(-85.05112878, 85.05112878).to_radians();
    (
        (lon + 180.0) / 360.0,
        (1.0 - (lat.tan() + 1.0 / lat.cos()).ln() / std::f64::consts::PI) / 2.0,
    )
}

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

fn positions(c: &Value) -> Vec<(f64, f64)> {
    c.as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| Some((p.get(0)?.as_f64()?, p.get(1)?.as_f64()?)))
        .collect()
}

/// A geometry split into what is drawn: polygons (rings, outer first), lines, points.
#[derive(Default)]
struct Parts {
    polygons: Vec<Vec<Vec<(f64, f64)>>>,
    lines: Vec<Vec<(f64, f64)>>,
    points: Vec<(f64, f64)>,
}

fn parts(g: &Value, out: &mut Parts) {
    let c = &g["coordinates"];
    let rings = |p: &Value| p.as_array().into_iter().flatten().map(positions).collect::<Vec<_>>();
    match g.get("type").and_then(Value::as_str) {
        Some("Point") => out.points.extend(positions(&Value::Array(vec![c.clone()]))),
        Some("MultiPoint") => out.points.extend(positions(c)),
        Some("LineString") => out.lines.push(positions(c)),
        Some("MultiLineString") => out.lines.extend(c.as_array().into_iter().flatten().map(positions)),
        Some("Polygon") => out.polygons.push(rings(c)),
        Some("MultiPolygon") => out.polygons.extend(c.as_array().into_iter().flatten().map(rings)),
        Some("GeometryCollection") => g["geometries"]
            .as_array()
            .into_iter()
            .flatten()
            .for_each(|g| parts(g, out)),
        _ => {}
    }
}

/// A path in screen space with points under a pixel apart merged, and its bounds.
fn on_screen(points: impl Iterator<Item = Pos2>) -> (Vec<Pos2>, Rect) {
    let mut out: Vec<Pos2> = Vec::new();
    let mut bounds = Rect::NOTHING;
    for p in points {
        bounds.extend_with(p);
        if out.last().is_none_or(|last| last.distance_sq(p) >= 1.0) {
            out.push(p);
        }
    }
    (out, bounds)
}

/// A map tile's texture if it is loaded; asks for it otherwise (egui's http loader caches it).
fn loaded(ctx: &egui::Context, z: i32, x: i64, y: i64) -> Option<egui::TextureId> {
    match ctx.try_load_texture(
        &format!("{TILES}/{z}/{x}/{y}.png"),
        egui::TextureOptions::LINEAR,
        egui::load::SizeHint::default(),
    ) {
        Ok(egui::load::TexturePoll::Ready { texture }) => Some(texture.id),
        _ => None,
    }
}

struct Style {
    fill: Color32,
    stroke: Stroke,
}

/// Where the map looks: a Web Mercator centre (0..1) and a zoom level (fractional).
pub struct MapView {
    centre: (f64, f64),
    zoom: f64,
    /// The view whose data was last fitted; new data fits once.
    fitted: Option<String>,
    /// The map's last on-screen rectangle (for `zoom_to` from outside).
    rect: Rect,
}

impl Default for MapView {
    fn default() -> Self {
        Self {
            centre: (0.5, 0.42),
            zoom: 1.5,
            fitted: None,
            rect: Rect::from_min_size(Pos2::ZERO, Vec2::splat(400.0)),
        }
    }
}

impl MapView {
    fn world(&self) -> f64 {
        TILE * self.zoom.exp2()
    }

    fn to_screen(&self, rect: Rect, (lon, lat): (f64, f64)) -> Pos2 {
        let m = mercator(lon, lat);
        let w = self.world();
        rect.center() + Vec2::new(((m.0 - self.centre.0) * w) as f32, ((m.1 - self.centre.1) * w) as f32)
    }

    fn to_mercator(&self, rect: Rect, p: Pos2) -> (f64, f64) {
        let w = self.world();
        let d = p - rect.center();
        (self.centre.0 + d.x as f64 / w, self.centre.1 + d.y as f64 / w)
    }

    /// Zoom by `steps` levels, keeping `at` fixed on screen.
    fn zoom_at(&mut self, rect: Rect, at: Pos2, steps: f64) {
        let before = self.to_mercator(rect, at);
        self.zoom = (self.zoom + steps).clamp(0.0, 19.0);
        let after = self.to_mercator(rect, at);
        self.centre.0 += before.0 - after.0;
        self.centre.1 += before.1 - after.1;
    }

    /// Frame these geometries, no closer than `max_zoom`.
    fn fit<'a>(&mut self, rect: Rect, shapes: impl Iterator<Item = &'a Value>, max_zoom: f64) {
        let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for g in shapes {
            each_position(g, &mut |lon, lat| {
                let (x, y) = mercator(lon, lat);
                (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
            });
        }
        if !x0.is_finite() {
            return;
        }
        self.centre = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
        let span =
            ((x1 - x0) / (rect.width() as f64 - 60.0).max(1.0)).max((y1 - y0) / (rect.height() as f64 - 60.0).max(1.0));
        self.zoom = if span > 0.0 {
            (1.0 / (span * TILE)).log2().clamp(0.0, max_zoom)
        } else {
            max_zoom
        };
    }

    /// Frame one feature (a row clicked in the table).
    pub fn zoom_to(&mut self, shape: &Value) {
        self.fit(self.rect, std::iter::once(shape), 18.0);
    }

    /// Draw one feature; returns the vertices used.
    fn draw(&self, painter: &egui::Painter, rect: Rect, g: &Value, style: &Style) -> usize {
        let mut p = Parts::default();
        parts(g, &mut p);
        let mut used = 0;
        let dot = |at: Pos2| painter.circle(at, 3.5, style.fill.to_opaque(), Stroke::new(1.0, style.stroke.color));
        for &pt in &p.points {
            dot(self.to_screen(rect, pt));
            used += 8;
        }
        for line in &p.lines {
            let (pts, bounds) = on_screen(line.iter().map(|&q| self.to_screen(rect, q)));
            if !bounds.intersects(rect) {
                continue;
            }
            if bounds.width().max(bounds.height()) < DOT_BELOW {
                dot(bounds.center());
                continue;
            }
            used += pts.len();
            painter.add(Shape::line(pts, style.stroke));
        }
        for polygon in &p.polygons {
            let rings: Vec<(Vec<Pos2>, Rect)> = polygon
                .iter()
                .map(|r| on_screen(r.iter().map(|&q| self.to_screen(rect, q))))
                .collect();
            let Some((_, outer)) = rings.first() else { continue };
            if !outer.intersects(rect) {
                continue;
            }
            if outer.width().max(outer.height()) < DOT_BELOW {
                dot(outer.center());
                used += 8;
                continue;
            }
            // Fill: ear-cut triangles of the outer ring with its holes.
            let mut flat = Vec::new();
            let mut holes = Vec::new();
            for (i, (pts, _)) in rings.iter().enumerate() {
                if i > 0 {
                    holes.push(flat.len() / 2);
                }
                flat.extend(pts.iter().flat_map(|p| [p.x as f64, p.y as f64]));
            }
            if let Ok(triangles) = earcutr::earcut(&flat, &holes, 2) {
                let mut mesh = egui::Mesh::default();
                for xy in flat.chunks(2) {
                    mesh.colored_vertex(Pos2::new(xy[0] as f32, xy[1] as f32), style.fill);
                }
                for t in triangles.chunks(3) {
                    mesh.add_triangle(t[0] as u32, t[1] as u32, t[2] as u32);
                }
                painter.add(Shape::mesh(mesh));
            }
            for (pts, _) in rings {
                used += pts.len() * 2;
                painter.add(Shape::closed_line(pts, style.stroke));
            }
        }
        used
    }

    /// The map. `data` is (view, features by row id); `selected` the highlighted row.
    pub fn show(
        &mut self,
        ui: &mut Ui,
        data: Option<(&str, &[(i64, Value)])>,
        selected: Option<(i64, &Value)>,
        empty: &str,
    ) {
        let (rect, response) = ui.allocate_exact_size(ui.available_size(), egui::Sense::click_and_drag());
        self.rect = rect;
        let shapes = data.map_or(&[][..], |(_, s)| s);
        if let Some((view, _)) = data
            && self.fitted.as_deref() != Some(view)
        {
            self.fit(rect, shapes.iter().map(|(_, g)| g), 17.0);
            self.fitted = Some(view.to_string());
        }

        // Interaction.
        if response.dragged() {
            let w = self.world();
            let d = response.drag_delta();
            self.centre.0 -= d.x as f64 / w;
            self.centre.1 -= d.y as f64 / w;
        }
        if response.hovered() {
            let (scroll, pinch) = ui.input(|i| (i.smooth_scroll_delta.y, i.zoom_delta()));
            let steps = scroll as f64 / 120.0 + (pinch as f64).log2();
            if steps != 0.0
                && let Some(at) = response.hover_pos()
            {
                self.zoom_at(rect, at, steps);
            }
        }
        if response.double_clicked() {
            self.fit(rect, shapes.iter().map(|(_, g)| g), 17.0);
        }

        let painter = ui.painter_at(rect);
        painter.rect_filled(rect, 0.0, Color32::from_rgb(0xaa, 0xd3, 0xdf));

        // Tiles at the integer zoom below the view's, scaled to fit.
        let z = self.zoom.floor().clamp(0.0, 19.0) as i32;
        let n = 1i64 << z;
        let tile_px = (self.world() / n as f64) as f32;
        let top_left = self.to_mercator(rect, rect.min);
        let bottom_right = self.to_mercator(rect, rect.max);
        let range =
            |a: f64, b: f64| ((a * n as f64).floor() as i64).max(0)..=((b * n as f64).floor() as i64).min(n - 1);
        let w = self.world();
        for ty in range(top_left.1, bottom_right.1) {
            for tx in range(top_left.0, bottom_right.0) {
                let m = (tx as f64 / n as f64, ty as f64 / n as f64);
                let min =
                    rect.center() + Vec2::new(((m.0 - self.centre.0) * w) as f32, ((m.1 - self.centre.1) * w) as f32);
                let place = Rect::from_min_size(min, Vec2::splat(tile_px));
                // While a tile loads, show the part of a coarser tile already loaded (no spinner).
                for k in 0..=3.min(z) {
                    if let Some(texture) = loaded(ui.ctx(), z - k, tx >> k, ty >> k) {
                        let part = 1.0 / (1 << k) as f32;
                        let u = (tx - ((tx >> k) << k)) as f32 * part;
                        let v = (ty - ((ty >> k) << k)) as f32 * part;
                        let uv = Rect::from_min_size(Pos2::new(u, v), Vec2::splat(part));
                        painter.image(texture, place, uv, Color32::WHITE);
                        break;
                    }
                }
            }
        }

        // Features, then the selected one on top.
        let normal = Style {
            fill: colour::ACCENT.gamma_multiply(0.35),
            stroke: Stroke::new(1.2, colour::ACCENT),
        };
        let mut budget = MAX_VERTICES;
        for (_, g) in shapes {
            if budget == 0 {
                painter.text(
                    rect.left_bottom() + Vec2::new(6.0, -6.0),
                    egui::Align2::LEFT_BOTTOM,
                    "Too much detail to draw it all: zoom in",
                    egui::FontId::proportional(11.0),
                    Color32::from_gray(40),
                );
                break;
            }
            budget = budget.saturating_sub(self.draw(&painter, rect, g, &normal));
        }
        if let Some((_, g)) = selected {
            let highlight = Style {
                fill: colour::HIGHLIGHT.gamma_multiply(0.55),
                stroke: Stroke::new(2.0, colour::ERR),
            };
            self.draw(&painter, rect, g, &highlight);
        }

        // Controls and attribution.
        let mut buttons = ui.new_child(egui::UiBuilder::new().max_rect(Rect::from_min_size(
            rect.right_top() + Vec2::new(-40.0, 8.0),
            Vec2::new(32.0, 100.0),
        )));
        if buttons.button(" + ").clicked() {
            self.zoom_at(rect, rect.center(), 1.0);
        }
        if buttons.button(" − ").clicked() {
            self.zoom_at(rect, rect.center(), -1.0);
        }
        if buttons
            .button("Fit")
            .on_hover_text("Fit to the data (or double-click)")
            .clicked()
        {
            self.fit(rect, shapes.iter().map(|(_, g)| g), 17.0);
        }
        let credit = "© OpenStreetMap contributors";
        let at = rect.right_bottom() - Vec2::new(6.0, 4.0);
        let galley = painter.layout_no_wrap(credit.into(), egui::FontId::proportional(11.0), Color32::from_gray(40));
        painter.rect_filled(
            Rect::from_min_size(at - galley.size() - Vec2::splat(3.0), galley.size() + Vec2::splat(6.0)),
            3.0,
            Color32::from_white_alpha(200),
        );
        painter.galley(at - galley.size(), galley, Color32::from_gray(40));
        if data.is_none() {
            painter.text(
                rect.center(),
                egui::Align2::CENTER_CENTER,
                empty,
                Default::default(),
                Color32::from_gray(90),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn on_screen_merges_close_points() {
        let dense = (0..10_000).map(|i| Pos2::new(10.0 + i as f32 * 0.001, 10.0));
        let (pts, bounds) = on_screen(dense);
        assert!(pts.len() < 15);
        assert!(bounds.width() > 9.0);
    }

    #[test]
    fn polygons_keep_their_holes() {
        let g = serde_json::json!({"type": "MultiPolygon", "coordinates": [
            [[[0, 0], [4, 0], [4, 4], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 1]]],
            [[[10, 10], [11, 10], [11, 11], [10, 10]]]
        ]});
        let mut p = Parts::default();
        parts(&g, &mut p);
        assert_eq!(p.polygons.len(), 2);
        assert_eq!(p.polygons[0].len(), 2, "outer ring and one hole");
    }
}
