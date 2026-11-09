//! The window: canvas in the middle, inspector on the right, table and map below.

use std::collections::BTreeMap;

use egui_snarl::Snarl;
use egui_snarl::ui::SnarlWidget;
use geomarmot_core::graph::NodeState;

use crate::canvas::{CATALOGUE, NodeData, PALETTE, Viewer, colour, from_palette, to_graph};
use crate::worker::{Job, Reply, Table, Worker};

pub struct App {
    pub snarl: Snarl<NodeData>,
    pub viewer: Viewer,
    worker: Worker,
    generation: u64,
    states: BTreeMap<usize, NodeState>,
    /// The view shown in the table and map, and what was read from it.
    shown: Option<(String, Result<Table, String>)>,
    pub tab_map: bool,
    status: String,
    /// Files opened, as (relation, label): the Layers list.
    layers: Vec<(String, String)>,
    styled: bool,
    #[cfg(not(target_arch = "wasm32"))]
    pub probe: Option<crate::probe::Probe>,
}

impl App {
    pub fn new(worker: Worker) -> Self {
        Self {
            snarl: Snarl::new(),
            viewer: Viewer::default(),
            worker,
            generation: 0,
            states: BTreeMap::new(),
            shown: None,
            tab_map: false,
            status: "Open a file to start.".into(),
            layers: Vec::new(),
            styled: false,
            #[cfg(not(target_arch = "wasm32"))]
            probe: None,
        }
    }

    /// Open a file, as the Open button does after its dialog.
    pub fn open(&mut self, path: std::path::PathBuf) {
        self.send(Job::Open(path));
    }

    /// Export the selected port, as the Export button does after its dialog.
    pub fn export(&mut self, to: std::path::PathBuf) {
        if let Some(view) = self.selected_view() {
            self.send(Job::Export { view, to });
        }
    }

    pub fn status(&self) -> &str {
        &self.status
    }

    /// The rows shown in the table, once read.
    pub fn shown_rows(&self) -> Option<usize> {
        match &self.shown {
            Some((_, Ok(t))) => Some(t.rows.len()),
            _ => None,
        }
    }

    pub fn send(&mut self, job: Job) {
        self.worker.send(job);
    }

    fn compile(&mut self) {
        let graph = to_graph(&self.snarl);
        self.send(Job::Compile(graph));
        self.status = "Compiling…".into();
    }

    /// The view of the selected port in the current generation, if it compiled.
    fn selected_view(&self) -> Option<String> {
        let (node, port) = self.viewer.selected?;
        match self.states.get(&node)? {
            NodeState::Ready { ports, .. } => ports.get(port).map(|(_, v)| v.clone()),
            _ => None,
        }
    }

    pub fn poll(&mut self) {
        while let Ok(reply) = self.worker.replies.try_recv() {
            match reply {
                Reply::Opened { relation, label } => {
                    self.layers.push((relation.clone(), label.clone()));
                    let pos = self.viewer.place(self.snarl.node_ids().count());
                    self.snarl.insert_node(pos, NodeData::reader(&relation, &label));
                    self.status = format!("Opened {label}.");
                    self.compile();
                }
                Reply::Compiled { generation, states } if generation > self.generation => {
                    self.generation = generation;
                    for (id, data) in self.snarl.nodes_ids_mut() {
                        data.state = states.get(&id.0).cloned();
                    }
                    let errors = states.values().filter(|s| matches!(s, NodeState::Error(_))).count();
                    self.status = if errors == 0 {
                        "Ready.".into()
                    } else {
                        format!("{errors} node(s) failed.")
                    };
                    self.states = states;
                    self.shown = None;
                }
                Reply::Compiled { .. } => {}
                Reply::Read { view, table } if Some(&view) == self.selected_view().as_ref() => {
                    self.shown = Some((view, table))
                }
                Reply::Read { .. } => {}
                Reply::Status(s) => self.status = s,
            }
        }
        if let Some(view) = self.selected_view()
            && self.shown.as_ref().map(|(v, _)| v) != Some(&view)
        {
            self.shown = Some((view.clone(), Err("Reading…".into())));
            self.send(Job::Read { view });
        }
    }

    fn top_bar(&mut self, ui: &mut egui::Ui) {
        let white = |t: &str| egui::RichText::new(t).color(egui::Color32::WHITE);
        let later = "Not in the Rust version yet";
        let dim = |t: &str| egui::RichText::new(t).color(egui::Color32::from_gray(110));
        ui.horizontal_centered(|ui| {
            ui.label(egui::RichText::new("GeoMarmot").size(18.0).color(egui::Color32::WHITE));
            ui.add_space(24.0);
            ui.separator();
            if ui.add(egui::Button::new(white("New")).frame(false)).clicked() {
                self.snarl = egui_snarl::Snarl::new();
                self.viewer.selected = None;
                self.viewer.changed = true;
            }
            if ui.add(egui::Button::new(white("Open…")).frame(false)).clicked() {
                self.pick_file();
            }
            ui.add_enabled(false, egui::Button::new(dim("Save")).frame(false))
                .on_disabled_hover_text(later);
            ui.separator();
            ui.add_enabled(false, egui::Button::new(dim("Connect")).frame(false))
                .on_disabled_hover_text(later);
            ui.separator();
            if ui
                .add_enabled(
                    self.selected_view().is_some(),
                    egui::Button::new(white("Export…")).frame(false),
                )
                .clicked()
            {
                self.pick_export();
            }
            if ui.add(egui::Button::new(white("Cancel")).frame(false)).clicked() {
                self.status = self.worker.cancel();
            }
            ui.separator();
            for name in ["Undo", "Redo"] {
                ui.add_enabled(false, egui::Button::new(dim(name)).frame(false))
                    .on_disabled_hover_text(later);
            }
            ui.separator();
            for name in ["Arrange", "Assistant"] {
                ui.add_enabled(false, egui::Button::new(dim(name)).frame(false))
                    .on_disabled_hover_text(later);
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.label(egui::RichText::new(&self.status).color(egui::Color32::from_gray(220)));
            });
        });
    }

    /// The left rail: opened files, then the toolbox by group.
    fn rail(&mut self, ui: &mut egui::Ui) {
        egui::ScrollArea::vertical().show(ui, |ui| {
            ui.add_space(8.0);
            ui.label(egui::RichText::new("Layers").size(16.0));
            ui.add_space(4.0);
            egui::Frame::new()
                .stroke(egui::Stroke::new(1.0, colour::BORDER))
                .corner_radius(5)
                .inner_margin(8)
                .show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.vertical_centered(|ui| {
                        ui.label(
                            egui::RichText::new("Drop files here, or use Open")
                                .small()
                                .color(colour::MUTED),
                        );
                    });
                });
            let mut add = None;
            for (relation, label) in &self.layers {
                if ui
                    .add(egui::Button::new(label.as_str()).frame(false))
                    .on_hover_text("Add a Reader for this file")
                    .clicked()
                {
                    add = Some((relation.clone(), label.clone()));
                }
            }
            if let Some((relation, label)) = add {
                let pos = self.viewer.place(self.snarl.node_ids().count());
                self.snarl.insert_node(pos, NodeData::reader(&relation, &label));
                self.viewer.changed = true;
            }
            ui.add_space(10.0);
            ui.separator();
            ui.label(egui::RichText::new("Transformers").size(16.0));
            for (group, ids) in CATALOGUE {
                ui.add_space(6.0);
                ui.label(egui::RichText::new(group.to_uppercase()).small().color(colour::MUTED));
                for id in *ids {
                    let ported = PALETTE.iter().find(|(kind, _)| kind == id);
                    let button = egui::Button::new(*id).frame(false);
                    match ported {
                        Some((kind, params)) => {
                            if ui.add(button).clicked() {
                                let pos = self.viewer.place(self.snarl.node_ids().count());
                                let node = self.snarl.insert_node(pos, from_palette(kind, params));
                                self.viewer.selected = Some((node.0, 0));
                                self.viewer.changed = true;
                            }
                        }
                        None if *id == "Reader" => {
                            if ui.add(button).on_hover_text("Open a file to add a Reader").clicked() {
                                self.pick_file();
                            }
                        }
                        None => {
                            ui.add_enabled(false, button)
                                .on_disabled_hover_text("Not in the Rust version yet");
                        }
                    }
                }
            }
        });
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn pick_file(&mut self) {
        if let Some(path) = rfd::FileDialog::new().pick_file() {
            self.send(Job::Open(path));
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn pick_export(&mut self) {
        let dialog = rfd::FileDialog::new().add_filter("data", &["parquet", "csv", "gpkg", "geojson"]);
        if let (Some(view), Some(to)) = (self.selected_view(), dialog.save_file()) {
            self.send(Job::Export { view, to });
        }
    }

    /// The browser's file picker is async: the bytes come back as a job.
    #[cfg(target_arch = "wasm32")]
    fn pick_file(&mut self) {
        let jobs = self.worker.sender();
        wasm_bindgen_futures::spawn_local(async move {
            if let Some(file) = rfd::AsyncFileDialog::new().pick_file().await {
                jobs(Job::OpenBytes {
                    name: file.file_name(),
                    bytes: file.read().await,
                });
            }
        });
    }

    /// The browser downloads the export; Parquet unless asked otherwise.
    #[cfg(target_arch = "wasm32")]
    fn pick_export(&mut self) {
        if let Some(view) = self.selected_view() {
            self.send(Job::Export {
                view,
                to: "export.parquet".into(),
            });
        }
    }

    /// Files dropped on the window: paths on the desktop, bytes in the browser.
    fn dropped_files(&mut self, ctx: &egui::Context) {
        for file in ctx.input(|i| i.raw.dropped_files.clone()) {
            #[cfg(not(target_arch = "wasm32"))]
            self.open(file.path().to_path_buf());
            #[cfg(target_arch = "wasm32")]
            {
                let jobs = self.worker.sender();
                wasm_bindgen_futures::spawn_local(async move {
                    let name = file.path().to_string_lossy().into_owned();
                    match file.bytes_async().await {
                        Ok(bytes) => jobs(Job::OpenBytes { name, bytes }),
                        Err(e) => web_sys::console::error_1(&format!("{name}: {e}").into()),
                    }
                });
            }
        }
    }

    fn inspector(&mut self, ui: &mut egui::Ui) {
        let Some((node, _)) = self.viewer.selected else {
            ui.add_space(12.0);
            ui.label("Select a node to edit it.");
            return;
        };
        let id = egui_snarl::NodeId(node);
        let Some(data) = self.snarl.get_node_mut(id) else {
            return;
        };
        ui.heading(&data.node.kind);
        if let Some(NodeState::Error(e)) = &data.state {
            ui.colored_label(egui::Color32::from_rgb(200, 80, 70), e);
        }
        if data.node.kind != "Reader" {
            ui.label("Parameters (JSON)");
            if ui
                .add(egui::TextEdit::multiline(&mut data.text).code_editor().desired_rows(12))
                .changed()
                && let Ok(params) = serde_json::from_str(&data.text)
            {
                data.node.params = params;
                self.viewer.changed = true;
            }
        }
    }

    /// Attributes on the left, geometry on the right, as the JavaScript dock.
    fn results(&mut self, ui: &mut egui::Ui) {
        let message = match &self.shown {
            None => Some("Select a node.".to_string()),
            Some((_, Err(e))) => Some(e.clone()),
            Some(_) => None,
        };
        ui.columns(2, |cols| {
            cols[0].horizontal(|ui| {
                ui.label(egui::RichText::new("Attributes").size(16.0));
                if let Some(m) = &message {
                    ui.label(egui::RichText::new(m).small().color(colour::MUTED));
                } else if let Some((_, Ok(t))) = &self.shown {
                    ui.label(
                        egui::RichText::new(format!("{} rows", t.rows.len()))
                            .small()
                            .color(colour::MUTED),
                    );
                }
            });
            cols[0].separator();
            cols[1].label(egui::RichText::new("Geometry").size(16.0));
            cols[1].separator();
            if let Some((_, Ok(table))) = &self.shown {
                Self::table(&mut cols[0], table);
                crate::map::show(&mut cols[1], &table.shapes);
            }
        });
    }

    fn table(ui: &mut egui::Ui, table: &Table) {
        use egui_extras::{Column, TableBuilder};
        egui::ScrollArea::horizontal().show(ui, |ui| {
            TableBuilder::new(ui)
                .striped(true)
                .columns(Column::auto().clip(true).at_most(320.0), table.columns.len())
                .header(20.0, |mut h| {
                    for c in &table.columns {
                        h.col(|ui| {
                            ui.strong(c);
                        });
                    }
                })
                .body(|body| {
                    body.rows(18.0, table.rows.len(), |mut row| {
                        let r = &table.rows[row.index()];
                        for cell in r {
                            row.col(|ui| {
                                ui.label(cell);
                            });
                        }
                    });
                });
        });
    }
}

/// Light paper theme with the JavaScript app's tokens.
fn apply_theme(ctx: &egui::Context) {
    ctx.set_theme(egui::Theme::Light);
    ctx.style_mut_of(egui::Theme::Light, |style| {
        let v = &mut style.visuals;
        v.panel_fill = egui::Color32::WHITE;
        v.window_fill = egui::Color32::WHITE;
        v.extreme_bg_color = colour::PAPER_1;
        v.faint_bg_color = colour::PAPER_2;
        v.override_text_color = Some(colour::INK);
        v.selection.bg_fill = colour::ACCENT_SOFT;
        v.selection.stroke = egui::Stroke::new(1.0, colour::ACCENT);
        v.hyperlink_color = colour::ACCENT;
        v.widgets.noninteractive.bg_stroke = egui::Stroke::new(1.0, colour::BORDER);
        v.widgets.hovered.weak_bg_fill = colour::PAPER_2;
        v.widgets.hovered.bg_stroke = egui::Stroke::new(1.0, colour::ACCENT_SOFT);
    });
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        self.poll();
        #[cfg(target_arch = "wasm32")]
        crate::hooks::run(self, &ui.ctx().clone());
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(probe) = &mut self.probe {
            probe.frame(ui.ctx(), &self.worker);
        }
        if !std::mem::replace(&mut self.styled, true) {
            apply_theme(ui.ctx());
        }
        self.dropped_files(&ui.ctx().clone());
        egui::Panel::top("bar")
            .frame(
                egui::Frame::new()
                    .fill(colour::INK_DEEP)
                    .inner_margin(egui::Margin::symmetric(14, 10)),
            )
            .show(ui, |ui| self.top_bar(ui));
        egui::Panel::left("rail")
            .default_size(240.0)
            .frame(
                egui::Frame::new()
                    .fill(egui::Color32::WHITE)
                    .inner_margin(egui::Margin::symmetric(14, 4)),
            )
            .show(ui, |ui| self.rail(ui));
        egui::Panel::right("inspector")
            .default_size(300.0)
            .frame(egui::Frame::new().fill(egui::Color32::WHITE).inner_margin(14))
            .show(ui, |ui| self.inspector(ui));
        egui::Panel::bottom("results")
            .resizable(true)
            .default_size(300.0)
            .min_size(200.0)
            .frame(egui::Frame::new().fill(egui::Color32::WHITE).inner_margin(10))
            .show(ui, |ui| self.results(ui));
        egui::CentralPanel::default()
            .frame(egui::Frame::new().fill(colour::PAPER_2))
            .show(ui, |ui| {
                self.viewer.canvas = Some(ui.max_rect());
                SnarlWidget::new()
                    .style(crate::canvas::style())
                    .show(&mut self.snarl, &mut self.viewer, ui);
                let hovering = ui.ctx().input(|i| !i.raw.hovered_files.is_empty());
                if hovering || self.snarl.node_ids().next().is_none() {
                    let text = if hovering {
                        "Drop to open"
                    } else {
                        "Drop a file here, or pick a transformer on the left"
                    };
                    ui.painter().text(
                        ui.max_rect().center(),
                        egui::Align2::CENTER_CENTER,
                        text,
                        egui::FontId::proportional(16.0),
                        colour::MUTED,
                    );
                }
            });
        if std::mem::take(&mut self.viewer.changed) {
            self.compile();
        }
    }
}
