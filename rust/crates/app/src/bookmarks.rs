//! Bookmarks: a titled, coloured area behind nodes. The nodes whose centre is inside belong to
//! it; dragging its title moves them with it, its corner resizes it.

use egui::{Color32, Pos2, Rect};
use egui_snarl::{NodeId, Snarl};

use crate::canvas::{NodeData, Viewer, Z};

#[derive(Debug, Clone, PartialEq)]
pub struct Bookmark {
    pub title: String,
    pub colour: usize,
    /// Graph coordinates, title bar included.
    pub rect: Rect,
}

const COLOURS: &[Color32] = &[
    Color32::from_rgb(0x7f, 0xae, 0x8c),
    Color32::from_rgb(0x6f, 0x96, 0xad),
    Color32::from_rgb(0xd9, 0x91, 0x3a),
    Color32::from_rgb(0xb0, 0x8f, 0xc7),
    Color32::from_rgb(0xc0, 0x56, 0x3f),
    Color32::from_rgb(0x9a, 0x9a, 0x8c),
];

/// Height of the title bar, in graph units.
const TITLE: f32 = 26.0 * Z;

fn colour(b: &Bookmark) -> Color32 {
    COLOURS[b.colour % COLOURS.len()]
}

fn title_bar(r: Rect) -> Rect {
    Rect::from_min_max(r.min, egui::pos2(r.max.x, r.min.y + TITLE))
}

/// The two buttons at the right of the title bar: (change colour, delete).
fn buttons(r: Rect) -> (Rect, Rect) {
    let bar = title_bar(r);
    let size = egui::vec2(TITLE, TITLE);
    let close = Rect::from_min_size(egui::pos2(bar.max.x - TITLE, bar.min.y), size);
    (close.translate(egui::vec2(-TITLE, 0.0)), close)
}

/// A bookmark around `nodes` (their last drawn rects), with room for its title.
pub fn around(v: &Viewer, nodes: &[usize], title: String, colour: usize) -> Option<Bookmark> {
    let rect = v
        .node_rects
        .iter()
        .filter(|(n, _)| nodes.contains(n))
        .fold(Rect::NOTHING, |r, (_, n)| r.union(*n));
    rect.is_positive().then(|| {
        let r = rect.expand(20.0 * Z);
        Bookmark {
            title,
            colour,
            // Room above the nodes for their floating ▶ and × buttons.
            rect: Rect::from_min_max(r.min - egui::vec2(0.0, TITLE + 30.0 * Z), r.max),
        }
    })
}

/// Draw them behind the nodes (in graph coordinates).
pub fn draw(painter: &egui::Painter, bookmarks: &[Bookmark]) {
    for b in bookmarks {
        let c = colour(b);
        let radius = 6.0 * Z;
        painter.rect_filled(b.rect, radius, c.gamma_multiply(0.18));
        painter.rect_stroke(b.rect, radius, egui::Stroke::new(1.5 * Z, c), egui::StrokeKind::Inside);
        let bar = title_bar(b.rect);
        let top = egui::CornerRadius {
            nw: 12,
            ne: 12,
            sw: 0,
            se: 0,
        };
        painter.rect_filled(bar, top, c);
        let font = egui::FontId::proportional(14.0 * Z);
        // The title stops before the two buttons.
        let room = Rect::from_min_max(bar.min, egui::pos2(bar.max.x - 2.0 * TITLE, bar.max.y));
        painter.with_clip_rect(room.intersect(painter.clip_rect())).text(
            bar.left_center() + egui::vec2(10.0 * Z, 0.0),
            egui::Align2::LEFT_CENTER,
            &b.title,
            font.clone(),
            Color32::WHITE,
        );
        let (paint, close) = buttons(b.rect);
        painter.circle_filled(paint.center(), 5.0 * Z, COLOURS[(b.colour + 1) % COLOURS.len()]);
        painter.circle_stroke(paint.center(), 5.0 * Z, egui::Stroke::new(1.0 * Z, Color32::WHITE));
        painter.text(
            close.center(),
            egui::Align2::CENTER_CENTER,
            "×",
            egui::FontId::proportional(18.0 * Z),
            Color32::WHITE,
        );
        // The resize grip.
        let m = b.rect.max - egui::vec2(4.0 * Z, 4.0 * Z);
        for k in 1..=3 {
            let d = 4.0 * Z * k as f32;
            painter.line_segment(
                [m - egui::vec2(d, 0.0), m - egui::vec2(0.0, d)],
                egui::Stroke::new(1.0 * Z, c),
            );
        }
    }
}

/// What a press on a bookmark started.
pub enum Drag {
    Move(usize, Vec<usize>),
    Resize(usize),
}

/// Nodes whose centre is inside the bookmark.
fn members(v: &Viewer, b: &Bookmark) -> Vec<usize> {
    v.node_rects
        .iter()
        .filter(|(_, r)| b.rect.contains(r.center()))
        .map(|(n, _)| *n)
        .collect()
}

/// The bookmark whose title bar is under `pos` (screen), the top one first.
pub fn title_at(v: &Viewer, pos: Pos2) -> Option<usize> {
    let p = v.to_global.inverse() * pos;
    (0..v.bookmarks.len())
        .rev()
        .find(|&i| title_bar(v.bookmarks[i].rect).contains(p))
}

/// A press at `pos` (screen) not on a node: the bookmark's buttons act at once, its title starts
/// a move, its corner a resize. None when the press is not on a bookmark's controls.
pub fn press(v: &mut Viewer, pos: Pos2) -> Option<Drag> {
    let p = v.to_global.inverse() * pos;
    let grip = 16.0 / v.to_global.scaling;
    for i in (0..v.bookmarks.len()).rev() {
        let b = &v.bookmarks[i];
        let (paint, close) = buttons(b.rect);
        if close.contains(p) {
            v.bookmarks.remove(i);
            return None;
        }
        if paint.contains(p) {
            v.bookmarks[i].colour += 1;
            return None;
        }
        if title_bar(b.rect).contains(p) {
            return Some(Drag::Move(i, members(v, b)));
        }
        if Rect::from_center_size(b.rect.max, egui::vec2(grip, grip)).contains(p) {
            return Some(Drag::Resize(i));
        }
    }
    None
}

/// Apply a drag by `delta` (screen).
pub fn drag(v: &mut Viewer, snarl: &mut Snarl<NodeData>, what: &Drag, delta: egui::Vec2) {
    let d = delta / v.to_global.scaling;
    match what {
        Drag::Move(i, nodes) => {
            if let Some(b) = v.bookmarks.get_mut(*i) {
                b.rect = b.rect.translate(d);
            }
            for n in nodes {
                if let Some(info) = snarl.get_node_info_mut(NodeId(*n)) {
                    info.pos += d;
                }
            }
        }
        Drag::Resize(i) => {
            if let Some(b) = v.bookmarks.get_mut(*i) {
                let min = b.rect.min + egui::vec2(120.0 * Z, TITLE + 40.0 * Z);
                b.rect.max = (b.rect.max + d).max(min);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moving_a_bookmark_moves_the_nodes_inside_it_only() {
        let mut snarl = Snarl::new();
        let inside = snarl.insert_node(egui::pos2(10.0, 60.0), crate::canvas::from_palette("Bufferer"));
        let outside = snarl.insert_node(egui::pos2(900.0, 60.0), crate::canvas::from_palette("Bufferer"));
        let mut v = Viewer::default();
        v.node_rects = vec![
            (
                inside.0,
                Rect::from_min_size(egui::pos2(10.0, 60.0), egui::vec2(100.0, 50.0)),
            ),
            (
                outside.0,
                Rect::from_min_size(egui::pos2(900.0, 60.0), egui::vec2(100.0, 50.0)),
            ),
        ];
        let b = around(&v, &[inside.0], "Inputs".into(), 0).unwrap();
        assert!(b.rect.contains(egui::pos2(60.0, 85.0)));
        v.bookmarks.push(b);
        // A press on the title bar (identity view: screen = graph) starts a move.
        let on_title = v.bookmarks[0].rect.min + egui::vec2(20.0, 10.0);
        let what = press(&mut v, on_title).expect("a move");
        drag(&mut v, &mut snarl, &what, egui::vec2(30.0, 5.0));
        assert_eq!(snarl.get_node_info(inside).unwrap().pos, egui::pos2(40.0, 65.0));
        assert_eq!(snarl.get_node_info(outside).unwrap().pos, egui::pos2(900.0, 60.0));
        // Its × deletes it.
        let (_, close) = buttons(v.bookmarks[0].rect);
        assert!(press(&mut v, close.center()).is_none());
        assert!(v.bookmarks.is_empty());
    }
}
