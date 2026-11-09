//! Toolbar icons: the JavaScript toolbar's line icons (app/index.html, a 24-unit box, 1.7
//! stroke), drawn with the painter rather than an SVG renderer. Bookmark and Export are new,
//! in the same style.

use egui::{Color32, Pos2, Rect, Response, Sense, Shape, Stroke, Ui};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Icon {
    New,
    Open,
    Save,
    Bookmark,
    Connect,
    Run,
    Cancel,
    Export,
    Undo,
    Redo,
    Arrange,
    Assistant,
}

/// Points along a circle (centre, radius) from angle `a` to `b`, in degrees (0 = +x, 90 = +y, down).
fn arc(c: [f32; 2], r: f32, a: f32, b: f32) -> Vec<[f32; 2]> {
    (0..=12)
        .map(|k| {
            let t = (a + (b - a) * k as f32 / 12.0).to_radians();
            [c[0] + r * t.cos(), c[1] + r * t.sin()]
        })
        .collect()
}

type Paths = Vec<Vec<[f32; 2]>>;

/// The icon as open polylines and filled polygons, in the 24-unit box.
fn shapes(icon: Icon) -> (Paths, Paths) {
    let p = |v: &[[f32; 2]]| v.to_vec();
    let rect = |x: f32, y: f32, w: f32, h: f32| p(&[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]);
    match icon {
        Icon::New => (
            vec![
                p(&[
                    [6.0, 3.0],
                    [14.0, 3.0],
                    [18.0, 7.0],
                    [18.0, 21.0],
                    [6.0, 21.0],
                    [6.0, 3.0],
                ]),
                p(&[[14.0, 3.0], [14.0, 7.0], [18.0, 7.0]]),
                p(&[[12.0, 11.0], [12.0, 17.0]]),
                p(&[[9.0, 14.0], [15.0, 14.0]]),
            ],
            vec![],
        ),
        Icon::Open => (
            vec![
                p(&[
                    [3.0, 6.5],
                    [4.5, 5.0],
                    [9.0, 5.0],
                    [11.0, 7.0],
                    [19.5, 7.0],
                    [21.0, 8.5],
                    [21.0, 10.0],
                ]),
                p(&[
                    [3.0, 6.5],
                    [3.0, 19.0],
                    [18.5, 19.0],
                    [21.0, 10.0],
                    [6.5, 10.0],
                    [3.0, 19.0],
                ]),
            ],
            vec![],
        ),
        Icon::Save => (
            vec![
                p(&[
                    [5.0, 3.0],
                    [16.5, 3.0],
                    [20.0, 6.5],
                    [20.0, 21.0],
                    [5.0, 21.0],
                    [5.0, 3.0],
                ]),
                p(&[[8.0, 3.0], [8.0, 8.0], [15.0, 8.0], [15.0, 3.0]]),
                p(&[[8.0, 21.0], [8.0, 14.0], [17.0, 14.0], [17.0, 21.0]]),
            ],
            vec![],
        ),
        Icon::Bookmark => (
            vec![
                p(&[
                    [6.0, 3.0],
                    [18.0, 3.0],
                    [18.0, 21.0],
                    [12.0, 16.5],
                    [6.0, 21.0],
                    [6.0, 3.0],
                ]),
                p(&[[9.5, 8.0], [14.5, 8.0]]),
            ],
            vec![],
        ),
        Icon::Connect => {
            let mut plug = p(&[[6.0, 11.0], [6.0, 7.0], [18.0, 7.0], [18.0, 11.0]]);
            plug.extend(arc([12.0, 11.0], 6.0, 0.0, 180.0));
            (
                vec![
                    p(&[[9.0, 3.0], [9.0, 7.0]]),
                    p(&[[15.0, 3.0], [15.0, 7.0]]),
                    plug,
                    p(&[[12.0, 17.0], [12.0, 21.0]]),
                ],
                vec![],
            )
        }
        Icon::Run => (vec![], vec![p(&[[8.0, 5.0], [19.0, 12.0], [8.0, 19.0]])]),
        Icon::Cancel => (vec![], vec![p(&[[7.0, 7.0], [17.0, 7.0], [17.0, 17.0], [7.0, 17.0]])]),
        Icon::Export => (
            vec![
                p(&[[12.0, 15.0], [12.0, 3.0]]),
                p(&[[7.0, 8.0], [12.0, 3.0], [17.0, 8.0]]),
                p(&[[4.0, 14.0], [4.0, 20.0], [20.0, 20.0], [20.0, 14.0]]),
            ],
            vec![],
        ),
        Icon::Undo => {
            let mut back = p(&[[4.0, 9.0], [15.0, 9.0]]);
            back.extend(arc([15.0, 14.0], 5.0, -90.0, 90.0));
            back.push([11.0, 19.0]);
            (vec![p(&[[9.0, 14.0], [4.0, 9.0], [9.0, 4.0]]), back], vec![])
        }
        Icon::Redo => {
            let mut back = p(&[[20.0, 9.0], [9.0, 9.0]]);
            back.extend(arc([9.0, 14.0], 5.0, 270.0, 90.0));
            back.push([13.0, 19.0]);
            (vec![p(&[[15.0, 14.0], [20.0, 9.0], [15.0, 4.0]]), back], vec![])
        }
        Icon::Arrange => (
            vec![
                rect(3.0, 4.0, 7.0, 5.0),
                rect(14.0, 4.0, 7.0, 5.0),
                rect(8.5, 15.0, 7.0, 5.0),
                p(&[[6.5, 9.0], [6.5, 12.0], [17.5, 12.0], [17.5, 9.0]]),
                p(&[[12.0, 12.0], [12.0, 15.0]]),
            ],
            vec![],
        ),
        Icon::Assistant => {
            let star = |c: [f32; 2], r: f32, s: f32| {
                let mut v: Vec<[f32; 2]> = (0..8)
                    .map(|k| {
                        let t = (k as f32 * 45.0 - 90.0).to_radians();
                        let d = if k % 2 == 0 { r } else { s };
                        [c[0] + d * t.cos(), c[1] + d * t.sin()]
                    })
                    .collect();
                v.push(v[0]);
                v
            };
            (vec![star([11.0, 10.0], 7.0, 2.7), star([18.5, 17.2], 2.7, 1.1)], vec![])
        }
    }
}

/// Paint `icon` into `rect` (square) in `colour`.
pub fn paint(painter: &egui::Painter, rect: Rect, icon: Icon, colour: Color32) {
    let scale = rect.width() / 24.0;
    let at = |q: &[f32; 2]| Pos2::new(rect.min.x + q[0] * scale, rect.min.y + q[1] * scale);
    let (lines, fills) = shapes(icon);
    let stroke = Stroke::new(1.7 * scale, colour);
    for l in lines {
        painter.add(Shape::line(l.iter().map(at).collect(), stroke));
    }
    for f in fills {
        painter.add(Shape::convex_polygon(f.iter().map(at).collect(), colour, Stroke::NONE));
    }
}

/// A toolbar button: icon then label, white (or `accent`), dimmed when disabled.
pub fn tool(ui: &mut Ui, icon: Icon, label: &str, enabled: bool, accent: Option<Color32>) -> Response {
    const ICON: f32 = 20.0;
    let colour = match (enabled, accent) {
        (false, _) => Color32::from_gray(110),
        (true, Some(c)) => c,
        (true, None) => Color32::WHITE,
    };
    let text = egui::WidgetText::from(egui::RichText::new(label).color(colour)).into_galley(
        ui,
        Some(egui::TextWrapMode::Extend),
        f32::INFINITY,
        egui::TextStyle::Button,
    );
    let pad = egui::vec2(6.0, 4.0);
    let size = egui::vec2(ICON + 5.0 + text.size().x, ICON.max(text.size().y)) + 2.0 * pad;
    let sense = if enabled { Sense::click() } else { Sense::hover() };
    let (rect, response) = ui.allocate_exact_size(size, sense);
    if response.hovered() && enabled {
        ui.painter().rect_filled(rect, 5.0, Color32::from_white_alpha(22));
    }
    let icon_rect = Rect::from_min_size(
        egui::pos2(rect.min.x + pad.x, rect.center().y - ICON / 2.0),
        egui::vec2(ICON, ICON),
    );
    paint(ui.painter(), icon_rect, icon, colour);
    let text_pos = egui::pos2(icon_rect.max.x + 5.0, rect.center().y - text.size().y / 2.0);
    ui.painter().galley(text_pos, text, colour);
    response
}
