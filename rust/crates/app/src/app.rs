//! The window: canvas in the middle, inspector on the right, table and map below.

use std::collections::BTreeMap;

use egui_snarl::Snarl;
use egui_snarl::ui::SnarlWidget;
use geomarmot_core::graph::NodeState;

use crate::canvas::{NodeData, Viewer, to_graph};
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
                    let pos = egui::pos2(40.0, 40.0 + 90.0 * self.snarl.node_ids().count() as f32);
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
        ui.horizontal(|ui| {
            if ui.button("Open file…").clicked() {
                self.pick_file();
            }
            if ui
                .add_enabled(self.selected_view().is_some(), egui::Button::new("Export…"))
                .clicked()
            {
                self.pick_export();
            }
            if ui.button("Cancel").clicked() {
                self.status = self.worker.cancel();
            }
            ui.separator();
            ui.label(&self.status);
            ui.label("· right-click the canvas to add a transformer, click an output to see its rows");
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

    fn inspector(&mut self, ui: &mut egui::Ui) {
        let Some((node, _)) = self.viewer.selected else {
            ui.label("Select an output port.");
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

    fn results(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.selectable_value(&mut self.tab_map, false, "Table");
            ui.selectable_value(&mut self.tab_map, true, "Map");
        });
        match &self.shown {
            None => {
                ui.label("Click an output port to see its rows.");
            }
            Some((_, Err(e))) => {
                ui.label(e);
            }
            Some((_, Ok(table))) if self.tab_map => crate::map::show(ui, &table.shapes),
            Some((_, Ok(table))) => {
                use egui_extras::{Column, TableBuilder};
                egui::ScrollArea::horizontal().show(ui, |ui| {
                    TableBuilder::new(ui)
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
    }
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
        egui::Panel::top("bar").show(ui, |ui| self.top_bar(ui));
        egui::Panel::right("inspector")
            .default_size(300.0)
            .show(ui, |ui| self.inspector(ui));
        egui::Panel::bottom("results")
            .resizable(true)
            .default_size(300.0)
            .min_size(240.0)
            .show(ui, |ui| self.results(ui));
        egui::CentralPanel::default().show(ui, |ui| {
            SnarlWidget::new().show(&mut self.snarl, &mut self.viewer, ui);
        });
        if std::mem::take(&mut self.viewer.changed) {
            self.compile();
        }
    }
}
