//! Type over the canvas (or double-click it) to search transformers, as in the JavaScript
//! app (app/src/ui/quickadd.js): ↑/↓ to choose, Enter to add at the pointer, Esc to close.

use crate::canvas::{CATALOGUE, PALETTE, colour};

pub struct QuickAdd {
    text: String,
    index: usize,
    /// Screen position it opened at; the node goes there.
    pub at: egui::Pos2,
    focus: bool,
}

/// Ported matches first, best first; then the unported ones, shown disabled.
// ponytail: substring then subsequence, not the JavaScript fuzzy score; port fuzzyScore if ranking matters.
fn matches(query: &str) -> (Vec<&'static str>, Vec<&'static str>) {
    let q = query.to_lowercase();
    let score = |name: &str| {
        let hay = name.to_lowercase();
        if let Some(i) = hay.find(&q) {
            return Some(1000 - i as i32);
        }
        // Initials: "aoa" → AreaOnAreaOverlayer.
        let initials: String = name.chars().filter(char::is_ascii_uppercase).collect();
        if initials.to_lowercase().starts_with(&q) {
            return Some(500);
        }
        let mut chars = hay.chars();
        q.chars().all(|c| chars.any(|h| h == c)).then_some(0)
    };
    let mut all: Vec<(i32, &'static str)> = CATALOGUE
        .iter()
        .flat_map(|(_, ids)| ids.iter().copied())
        .filter_map(|id| score(id).map(|s| (s, id)))
        .collect();
    all.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(b.1)));
    all.into_iter().map(|(_, id)| id).partition(|id| PALETTE.contains(id))
}

impl QuickAdd {
    pub fn new(seed: &str, at: egui::Pos2) -> Self {
        Self {
            text: seed.into(),
            index: 0,
            at,
            focus: true,
        }
    }

    /// Draw it. `Some(Some(kind))`: add that; `Some(None)`: close; `None`: keep open.
    pub fn show(&mut self, ctx: &egui::Context) -> Option<Option<&'static str>> {
        let (ported, unported) = matches(&self.text);
        self.index = self.index.min(ported.len().saturating_sub(1));
        let (up, down, enter, escape) = ctx.input_mut(|i| {
            (
                i.consume_key(egui::Modifiers::NONE, egui::Key::ArrowUp),
                i.consume_key(egui::Modifiers::NONE, egui::Key::ArrowDown),
                i.key_pressed(egui::Key::Enter),
                i.key_pressed(egui::Key::Escape),
            )
        });
        if !ported.is_empty() {
            let n = ported.len();
            if down {
                self.index = (self.index + 1) % n;
            }
            if up {
                self.index = (self.index + n - 1) % n;
            }
        }
        if escape {
            return Some(None);
        }
        if enter {
            return Some(ported.get(self.index).copied());
        }
        let mut result = None;
        egui::Area::new(egui::Id::new("quick-add"))
            .fixed_pos(self.at)
            .order(egui::Order::Foreground)
            .show(ctx, |ui| {
                egui::Frame::popup(ui.style()).show(ui, |ui| {
                    ui.set_width(240.0);
                    let edit = ui.add(egui::TextEdit::singleline(&mut self.text).hint_text("Add a transformer…"));
                    if std::mem::take(&mut self.focus) {
                        edit.request_focus();
                        // Put the cursor after the letter that opened it.
                        if let Some(mut state) = egui::TextEdit::load_state(ui.ctx(), edit.id) {
                            let end = egui::text::CCursor::new(self.text.chars().count());
                            state.cursor.set_char_range(Some(egui::text::CCursorRange::one(end)));
                            state.store(ui.ctx(), edit.id);
                        }
                    }
                    for (i, id) in ported.iter().enumerate() {
                        if ui.selectable_label(i == self.index, *id).clicked() {
                            result = Some(Some(*id));
                        }
                    }
                    for id in unported.iter().take(6) {
                        ui.label(egui::RichText::new(format!("{id} · not ported yet")).color(colour::MUTED));
                    }
                    if ported.is_empty() && unported.is_empty() {
                        ui.label(egui::RichText::new("No match").color(colour::MUTED));
                    }
                    // Clicking elsewhere closes it.
                    if edit.lost_focus() && result.is_none() && !ui.ctx().memory(|m| m.has_focus(edit.id)) {
                        result = Some(None);
                    }
                });
            });
        result
    }
}

#[cfg(test)]
mod tests {
    use super::matches;

    #[test]
    fn ranks_substring_then_subsequence() {
        let (ported, _) = matches("buf");
        assert_eq!(ported.first(), Some(&"Bufferer"));
        let (ported, _) = matches("aoa");
        assert_eq!(ported.first(), Some(&"AreaOnAreaOverlayer"));
        let (ported, unported) = matches("filter");
        assert!(ported.contains(&"AttributeFilter") && ported.contains(&"DuplicateFilter"));
        assert!(unported.iter().all(|id| !ported.contains(id)));
    }
}
