//! The app's graph file (Save, Open a `.flow.json`) and its bookmarks (create, drag).

use super::App;
use crate::bookmarks;

impl App {
    /// Save to the graph's file, asking where the first time (or with `ask`).
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn save_graph(&mut self, ask: bool) {
        let to = match (&self.project_path, ask) {
            (Some(p), false) => Some(p.clone()),
            _ => rfd::FileDialog::new()
                .add_filter("GeoMarmot graph", &["json"])
                .set_file_name("graph.flow.json")
                .save_file(),
        };
        let Some(to) = to else { return };
        let text = serde_json::to_string_pretty(&crate::project::save(&self.snarl, &self.viewer.bookmarks))
            .unwrap_or_default();
        self.status = match std::fs::write(&to, text) {
            Ok(()) => format!("Saved {}.", to.file_name().unwrap_or_default().to_string_lossy()),
            Err(e) => format!("Could not save {}: {e}", to.display()),
        };
        self.project_path = Some(to);
    }

    /// The browser cannot write files yet.
    #[cfg(target_arch = "wasm32")]
    pub(super) fn save_graph(&mut self, _ask: bool) {
        self.status = "Saving a graph works on the desktop for now.".into();
    }

    /// Replace the canvas with a saved graph; each Reader opens its file again.
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn open_graph(&mut self, path: std::path::PathBuf) {
        let loaded = std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string()))
            .and_then(|v| crate::project::load(&v));
        let (snarl, marks) = match loaded {
            Ok(x) => x,
            Err(e) => {
                self.status = format!("Could not open {}: {e}", path.display());
                return;
            }
        };
        self.snarl = snarl;
        self.viewer.bookmarks = marks;
        self.viewer.selected = None;
        self.viewer.tabs.clear();
        self.viewer.fit = true;
        self.states.clear();
        self.shown = None;
        self.reopen.clear();
        let readers: Vec<(serde_json::Value, String, egui_snarl::NodeId)> = self
            .snarl
            .node_ids()
            .filter(|(_, d)| d.node.kind == "Reader")
            .map(|(id, d)| (d.node.params.clone(), d.label.clone(), id))
            .collect();
        let mut problems = Vec::new();
        for (params, label, id) in readers {
            if let Some(file) = params["path"].as_str() {
                self.send(crate::worker::Job::Open(file.into()));
            } else if let Some(url) = params["url"].as_str() {
                self.send(crate::worker::Job::OpenUrl(url.into()));
            } else if params.get("connection").is_some() {
                match self.open_db_job(&params, label) {
                    Ok(job) => self.send(job),
                    Err(e) => {
                        problems.push(e);
                        continue;
                    }
                }
            } else {
                continue;
            }
            self.reopen.push((params, id));
        }
        self.status = format!("Opened {}.", path.file_name().unwrap_or_default().to_string_lossy());
        if !problems.is_empty() {
            self.status = format!("{} {}", self.status, problems.join(" "));
        }
        self.project_path = Some(path);
    }

    /// A bookmark around the nodes selected together, or the selected node.
    pub(super) fn add_bookmark(&mut self) {
        let mut nodes = self.viewer.multi.clone();
        if nodes.is_empty() {
            nodes.extend(self.viewer.selected.map(|(n, _)| n));
        }
        let n = self.viewer.bookmarks.len();
        if let Some(b) = bookmarks::around(&self.viewer, &nodes, format!("Bookmark {}", n + 1), n) {
            self.viewer.bookmarks.push(b);
        } else {
            self.status = "Select nodes first: click one, or drag a box around several.".into();
        }
    }

    /// Bookmark drags and the selection box, from the raw pointer, before the canvas takes the
    /// drag as a pan (panning is the middle or right button, or the trackpad). A left drag on
    /// empty canvas draws a box; the nodes it touches are selected together.
    /// True when the pointer is busy with a bookmark or a box.
    pub(super) fn bookmark_input(&mut self, ctx: &egui::Context, area: egui::Rect) -> bool {
        let (pressed, down, delta, pos) = ctx.input(|i| {
            (
                i.pointer.primary_pressed(),
                i.pointer.primary_down(),
                i.pointer.delta(),
                i.pointer.interact_pos(),
            )
        });
        if pressed && let Some(p) = pos.filter(|p| area.contains(*p)) {
            let on_node = self
                .viewer
                .node_rects
                .iter()
                .any(|(_, r)| (self.viewer.to_global * *r).contains(p));
            // A node's ports and floating buttons sit just outside it.
            let near_node = self
                .viewer
                .node_rects
                .iter()
                .any(|(_, r)| (self.viewer.to_global * *r).expand(14.0).contains(p));
            if on_node {
                // A click on a node outside the box ends the box selection.
                let hit = self
                    .viewer
                    .node_rects
                    .iter()
                    .find(|(_, r)| (self.viewer.to_global * *r).contains(p));
                if hit.is_some_and(|(n, _)| !self.boxed.contains(n)) {
                    self.boxed.clear();
                }
            } else {
                self.bookmark_drag = bookmarks::press(&mut self.viewer, p);
                let on_bookmark_title = bookmarks::title_at(&self.viewer, p).is_some();
                if self.bookmark_drag.is_none() && !near_node && !on_bookmark_title {
                    self.box_from = Some(p);
                }
                if self.bookmark_drag.is_some() || self.box_from.is_some() {
                    self.viewer.lock_view = Some(self.viewer.to_global);
                }
            }
        }
        if let Some(from) = self.box_from {
            let to = pos.unwrap_or(from);
            let r = egui::Rect::from_two_pos(from, to);
            if down {
                let painter = ctx.layer_painter(egui::LayerId::new(egui::Order::Foreground, egui::Id::new("box")));
                painter.rect_filled(r, 2.0, crate::canvas::colour::ACCENT_SOFT.gamma_multiply(0.15));
                painter.rect_stroke(
                    r,
                    2.0,
                    egui::Stroke::new(1.0, crate::canvas::colour::ACCENT),
                    egui::StrokeKind::Inside,
                );
                ctx.request_repaint();
            } else {
                // Released: the nodes the box touches (a click selects nothing).
                self.boxed = self
                    .viewer
                    .node_rects
                    .iter()
                    .filter(|(_, n)| (self.viewer.to_global * *n).intersects(r) && r.area() > 16.0)
                    .map(|(n, _)| *n)
                    .collect();
                self.box_from = None;
                self.viewer.lock_view = None;
            }
            return true;
        }
        if let Some(what) = &self.bookmark_drag {
            if down {
                bookmarks::drag(&mut self.viewer, &mut self.snarl, what, delta);
                ctx.request_repaint();
            } else {
                self.bookmark_drag = None;
                self.viewer.lock_view = None;
            }
        }
        self.bookmark_drag.is_some()
    }

    /// The rename field of a bookmark whose title was double-clicked.
    pub(super) fn bookmark_rename(&mut self, ctx: &egui::Context) {
        let Some((i, at)) = self.renaming else { return };
        let Some(b) = self.viewer.bookmarks.get_mut(i) else {
            self.renaming = None;
            return;
        };
        let mut done = false;
        egui::Area::new(egui::Id::new("bookmark-rename"))
            .fixed_pos(at)
            .order(egui::Order::Foreground)
            .show(ctx, |ui| {
                let edit = ui.add(egui::TextEdit::singleline(&mut b.title).desired_width(220.0));
                edit.request_focus();
                done = edit.lost_focus() || ui.input(|i| i.key_pressed(egui::Key::Enter));
            });
        if done {
            self.renaming = None;
        }
    }
}
