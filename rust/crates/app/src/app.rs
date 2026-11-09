//! The window: canvas in the middle, inspector on the right, table and map below.

use std::collections::BTreeMap;

use egui::Rect;
use egui_snarl::Snarl;
use egui_snarl::ui::SnarlWidget;
use geomarmot_core::graph::NodeState;

use crate::canvas::{CATALOGUE, NodeData, PALETTE, Viewer, colour, from_palette, to_graph};
use crate::worker::{Job, MAP_LIMIT, PAGE, Reply, Row, Table, Worker};
use geomarmot_core::thousands;

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
    quick: Option<crate::quickadd::QuickAdd>,
    /// The link under the pointer when the search opened: the new node goes into it.
    quick_link: Option<(egui_snarl::OutPinId, egui_snarl::InPinId)>,
    map: crate::map::MapView,
    /// The page being shown (first row) and the (view, offset) last asked for.
    offset: usize,
    requested: Option<(String, usize)>,
    /// The map's features: (view, row id + GeoJSON).
    features: Option<(String, Vec<(i64, serde_json::Value)>)>,
    /// The row clicked in the table (highlighted on the map), and the row whose ⓘ is open.
    picked: Option<Row>,
    info: Option<Row>,
    /// Attribute names per view (for the parameter pickers), and the views already asked.
    schemas: BTreeMap<String, Vec<String>>,
    asked: std::collections::BTreeSet<String>,
    /// The node whose parameters are open in the pop-up.
    form_open: Option<usize>,
    /// The frame's clock (egui input time), for elapsed times.
    now: f64,
    /// The run in progress: when it started, how many nodes, which one to show after.
    running: Option<(f64, usize, Option<usize>)>,
    /// What the last run did ("2 nodes in 2.1 s"), shown beside the status.
    note: String,
    /// The last canvas press (button, time, place), to time double-clicks.
    last_press: Option<(egui::PointerButton, f64, egui::Pos2)>,
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
            quick: None,
            quick_link: None,
            map: crate::map::MapView::default(),
            last_press: None,
            now: 0.0,
            running: None,
            note: String::new(),
            schemas: BTreeMap::new(),
            asked: Default::default(),
            form_open: None,
            offset: 0,
            requested: None,
            features: None,
            picked: None,
            info: None,
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

    /// The node whose parameters are open in the pop-up.
    pub fn editing(&self) -> Option<usize> {
        self.form_open
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

    /// Run the graph, or with `targets`, only what they need — keeping the nodes already run,
    /// with each output cached.
    // ponytail: every run rebuilds all it keeps (one generation at a time); keep per-node caches across runs if reruns get slow.
    pub fn run(&mut self, targets: Option<Vec<usize>>) {
        // The node asked for is shown once it ran.
        let targets_first = targets.as_ref().and_then(|t| t.first().copied());
        let graph = to_graph(&self.snarl);
        let graph = match targets {
            None => graph,
            Some(mut keep) => {
                keep.extend(
                    self.states
                        .iter()
                        .filter(|(_, s)| matches!(s, NodeState::Ready { .. }))
                        .map(|(id, _)| *id),
                );
                geomarmot_core::graph::upstream(&graph, &keep)
            }
        };
        let target = targets_first;
        self.viewer.running = graph.nodes.keys().copied().collect();
        self.running = Some((self.now, graph.nodes.len(), target));
        self.send(Job::Run(graph));
        self.status = "Running…".into();
        self.note.clear();
    }

    /// A small query for the inspector came back.
    fn rows_arrived(&mut self, key: String, rows: Result<Vec<Vec<serde_json::Value>>, String>) {
        let rows = match rows {
            Ok(rows) => rows,
            // The view was replaced by a newer run before the lookup ran: nothing to show.
            Err(_) if key.starts_with("schema:") || key.starts_with("count:") => return,
            Err(e) => {
                self.status = e;
                return;
            }
        };
        let strings = || -> Vec<String> {
            rows.iter()
                .filter_map(|r| r.first()?.as_str().map(String::from))
                .collect()
        };
        if let Some(view) = key.strip_prefix("count:") {
            let n = rows
                .first()
                .and_then(|r| r.first())
                .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()));
            if let Some(n) = n {
                self.viewer.counts.insert(view.to_string(), n);
            }
        } else if let Some(view) = key.strip_prefix("schema:") {
            self.schemas.insert(view.to_string(), strings());
        } else if let Some(rest) = key.strip_prefix("fill:")
            && let Some((node, param)) = rest.split_once(':')
            && let Ok(node) = node.parse::<usize>()
            && let Some(data) = self.snarl.get_node_mut(egui_snarl::NodeId(node))
        {
            data.node.params[param] =
                serde_json::Value::Array(strings().into_iter().map(serde_json::Value::String).collect());
            self.viewer.stale.push(node);
        }
    }

    /// Edited nodes and everything downstream are no longer run: their results go.
    fn invalidate(&mut self, edited: Vec<usize>) {
        let mut gone: Vec<usize> = Vec::new();
        for n in edited {
            for d in crate::canvas::downstream(&self.snarl, n) {
                if !gone.contains(&d) {
                    gone.push(d);
                }
            }
        }
        for n in &gone {
            self.states.remove(n);
            if let Some(data) = self.snarl.get_node_mut(egui_snarl::NodeId(*n)) {
                data.state = None;
            }
        }
        if self.selected_view().is_none() {
            self.shown = None;
        }
    }

    /// Tabs follow the selection: drop removed nodes, fall back to the last tab, and a node
    /// selected another way (its title, a run) replaces the tabs, as a plain eye click does.
    fn sync_tabs(&mut self) {
        let v = &mut self.viewer;
        v.tabs
            .retain(|(n, _)| self.snarl.get_node(egui_snarl::NodeId(*n)).is_some());
        if v.selected
            .is_some_and(|(n, _)| self.snarl.get_node(egui_snarl::NodeId(n)).is_none())
        {
            v.selected = None;
        }
        match v.selected {
            Some(s) if !v.tabs.contains(&s) => v.tabs = vec![s],
            None => v.selected = v.tabs.last().copied(),
            _ => {}
        }
    }

    /// One tab per open output, when there are several: click to show it, × to close it.
    fn tab_strip(&mut self, ui: &mut egui::Ui) {
        if self.viewer.tabs.len() < 2 {
            return;
        }
        let mut close = None;
        ui.horizontal(|ui| {
            for &tab in &self.viewer.tabs {
                let Some(data) = self.snarl.get_node(egui_snarl::NodeId(tab.0)) else {
                    continue;
                };
                let outputs = geomarmot_core::graph::ports(&data.node).1;
                let mut name = if data.label.is_empty() {
                    data.node.kind.clone()
                } else {
                    format!("{} · {}", data.node.kind, data.label)
                };
                if outputs.len() > 1 {
                    name = format!("{name} · {}", outputs.get(tab.1).map_or("", |s| s.as_str()));
                }
                let on = self.viewer.selected == Some(tab);
                egui::Frame::new()
                    .fill(if on {
                        egui::Color32::WHITE
                    } else {
                        egui::Color32::TRANSPARENT
                    })
                    .stroke(egui::Stroke::new(
                        1.0,
                        if on { colour::BORDER } else { egui::Color32::TRANSPARENT },
                    ))
                    .corner_radius(egui::CornerRadius {
                        nw: 6,
                        ne: 6,
                        sw: 0,
                        se: 0,
                    })
                    .inner_margin(egui::Margin::symmetric(8, 3))
                    .show(ui, |ui| {
                        let text = egui::RichText::new(name).color(if on { colour::INK } else { colour::MUTED });
                        if ui
                            .add(egui::Label::new(text).truncate().sense(egui::Sense::click()))
                            .clicked()
                        {
                            self.viewer.selected = Some(tab);
                        }
                        if ui
                            .add(egui::Button::new("×").small().frame(false))
                            .on_hover_text("Close")
                            .clicked()
                        {
                            close = Some(tab);
                        }
                    });
            }
        });
        if let Some(tab) = close {
            self.viewer.tabs.retain(|t| *t != tab);
            if self.viewer.selected == Some(tab) {
                self.viewer.selected = self.viewer.tabs.last().copied();
            }
        }
        ui.add_space(2.0);
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
                    let node = self.snarl.insert_node(pos, NodeData::reader(&relation, &label));
                    self.status = format!("Opened {label}.");
                    self.run(Some(vec![node.0]));
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
                    if let Some((since, count, target)) = self.running.take() {
                        let plural = if count == 1 { "" } else { "s" };
                        self.note = format!("{count} node{plural} in {:.1} s", self.now - since);
                        if let Some(first_error) = states.values().find_map(|s| match s {
                            NodeState::Error(e) => Some(e.clone()),
                            _ => None,
                        }) {
                            self.note = first_error;
                        }
                        // Show what was asked for, once it ran.
                        if let Some(t) = target
                            && matches!(states.get(&t), Some(NodeState::Ready { .. }))
                        {
                            self.viewer.selected = Some((t, 0));
                        }
                    }
                    self.viewer.running.clear();
                    // Row counts for the nodes' outputs ("Output 13,401").
                    for state in states.values() {
                        if let NodeState::Ready { ports, .. } = state {
                            for (_, view) in ports {
                                if !self.viewer.counts.contains_key(view) {
                                    self.worker.send(Job::Rows {
                                        key: format!("count:{view}"),
                                        sql: format!("SELECT count(*) FROM {view}"),
                                    });
                                }
                            }
                        }
                    }
                    self.states = states;
                    self.shown = None;
                }
                Reply::Compiled { .. } => {}
                Reply::Read { view, mut table } if Some(&view) == self.selected_view().as_ref() => {
                    if let Ok(t) = &mut table
                        && let Some(shapes) = t.shapes.take()
                    {
                        self.features = Some((view.clone(), shapes));
                    }
                    self.shown = Some((view, table))
                }
                Reply::Read { .. } => {}
                Reply::Rows { key, rows } => self.rows_arrived(key, rows),
                Reply::Status(s) => self.status = s,
            }
        }
        self.sync_tabs();
        if let Some(view) = self.selected_view()
            && self.requested.as_ref() != Some(&(view.clone(), self.offset))
        {
            // Another view: back to its first page, nothing picked.
            if self.requested.as_ref().map(|(v, _)| v) != Some(&view) {
                self.offset = 0;
                self.picked = None;
                self.info = None;
                let what = self
                    .viewer
                    .selected
                    .and_then(|(n, _)| self.snarl.get_node(egui_snarl::NodeId(n)))
                    .map(|d| d.node.kind.clone())
                    .unwrap_or_default();
                self.shown = Some((view.clone(), Err(format!("Reading {what}…"))));
            }
            self.requested = Some((view.clone(), self.offset));
            let offset = self.offset;
            let crs = match self.viewer.selected.and_then(|(n, _)| self.states.get(&n)) {
                Some(NodeState::Ready { crs, .. }) => crs.clone(),
                _ => String::new(),
            };
            self.send(Job::Read { view, crs, offset });
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
                self.states.clear();
                self.shown = None;
            }
            if ui.add(egui::Button::new(white("Open…")).frame(false)).clicked() {
                self.pick_file();
            }
            if ui
                .add_enabled(
                    self.snarl.node_ids().next().is_some(),
                    egui::Button::new(egui::RichText::new("▶ Run").color(colour::ACCENT_SOFT).strong()).frame(false),
                )
                .on_hover_text("Run the whole graph and cache every result")
                .clicked()
            {
                self.run(None);
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
            let busy = self.running.is_some();
            let cancel = if busy {
                egui::RichText::new("■ Cancel").color(colour::HIGHLIGHT).strong()
            } else {
                white("Cancel")
            };
            if ui.add(egui::Button::new(cancel).frame(false)).clicked() {
                self.status = self.worker.cancel();
                self.running = None;
                self.viewer.running.clear();
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
                if !self.note.is_empty() {
                    ui.label(
                        egui::RichText::new(&self.note)
                            .small()
                            .color(egui::Color32::from_gray(160)),
                    )
                    .on_hover_text(&self.note);
                }
                if let Some((since, count, _)) = self.running {
                    let plural = if count == 1 { "" } else { "s" };
                    ui.label(
                        egui::RichText::new(format!("Running {count} node{plural}… {:.1} s", self.now - since))
                            .color(egui::Color32::WHITE),
                    );
                    ui.add(egui::Spinner::new().size(14.0).color(colour::ACCENT_SOFT));
                    ui.ctx().request_repaint_after(std::time::Duration::from_millis(100));
                } else {
                    ui.label(egui::RichText::new(&self.status).color(egui::Color32::from_gray(220)));
                }
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
            }
            ui.add_space(10.0);
            ui.separator();
            ui.label(egui::RichText::new("Transformers").size(16.0));
            for (group, ids) in CATALOGUE {
                ui.add_space(6.0);
                ui.label(egui::RichText::new(group.to_uppercase()).small().color(colour::MUTED));
                for id in *ids {
                    let ported = PALETTE.iter().find(|kind| *kind == id);
                    let button = egui::Button::new(*id).frame(false);
                    match ported {
                        Some(kind) => {
                            if ui.add(button).clicked() {
                                let pos = self.viewer.place(self.snarl.node_ids().count());
                                let node = self.snarl.insert_node(pos, from_palette(kind));
                                self.viewer.selected = Some((node.0, 0));
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
        egui::ScrollArea::vertical().show(ui, |ui| self.node_form(ui, node));
    }

    /// The upstream (node state, output) feeding each input port of `node`.
    fn upstream(&self, node: usize) -> Vec<(String, Option<(String, String)>)> {
        let Some(data) = self.snarl.get_node(egui_snarl::NodeId(node)) else {
            return vec![];
        };
        let (inputs, _) = geomarmot_core::graph::ports(&data.node);
        inputs
            .into_iter()
            .enumerate()
            .map(|(k, port)| {
                let from = self
                    .snarl
                    .wires()
                    .find(|(_, i)| i.node.0 == node && i.input == k)
                    .and_then(|(o, _)| match self.states.get(&o.node.0) {
                        Some(NodeState::Ready { ports, crs }) => {
                            ports.get(o.output).map(|(_, v)| (v.clone(), crs.clone()))
                        }
                        _ => None,
                    });
                (port, from)
            })
            .collect()
    }

    /// Attribute names of each connected input; asks the engine once per view. An input that has
    /// not run is compiled, not run, to learn them (keyed by the graph feeding it).
    fn input_columns(&mut self, node: usize) -> crate::form::Columns {
        let mut out = crate::form::Columns::new();
        for (k, (port, from)) in self.upstream(node).into_iter().enumerate() {
            let Some((view, _)) = from else {
                let Some((o, _)) = self.snarl.wires().find(|(_, i)| i.node.0 == node && i.input == k) else {
                    continue;
                };
                let graph = geomarmot_core::graph::upstream(&crate::canvas::to_graph(&self.snarl), &[o.node.0]);
                let key = {
                    use std::hash::{Hash, Hasher};
                    let mut h = std::collections::hash_map::DefaultHasher::new();
                    format!("{graph:?}").hash(&mut h);
                    format!("compiled:{}:{}:{:x}", o.node.0, o.output, h.finish())
                };
                match self.schemas.get(&key) {
                    Some(names) => {
                        out.insert(port, names.clone());
                    }
                    None if self.asked.insert(key.clone()) => self.send(Job::Columns {
                        key: format!("schema:{key}"),
                        graph,
                        node: o.node.0,
                        port: o.output,
                    }),
                    None => {}
                }
                continue;
            };
            match self.schemas.get(&view) {
                Some(names) => {
                    out.insert(port, names.clone());
                }
                None if self.asked.insert(view.clone()) => self.send(Job::Rows {
                    key: format!("schema:{view}"),
                    sql: format!("SELECT column_name FROM (DESCRIBE {view}) WHERE column_type NOT LIKE 'GEOMETRY%'"),
                }),
                None => {}
            }
        }
        out
    }

    /// A node's editor: on the right, and in the double-click pop-up.
    fn node_form(&mut self, ui: &mut egui::Ui, node: usize) {
        let columns = self.input_columns(node);
        let upstream = self.upstream(node);
        let Some(data) = self.snarl.get_node_mut(egui_snarl::NodeId(node)) else {
            return;
        };
        ui.label(egui::RichText::new(&data.node.kind).size(18.0));
        let muted = |t: &str| egui::RichText::new(t).small().color(colour::MUTED);
        if let Some(NodeState::Error(e)) = &data.state {
            ui.colored_label(colour::ERR, e);
        }
        let mut fill = None;
        if data.node.kind == "Reader" {
            ui.label(muted("Reads a file opened or dropped on the window."));
            ui.add_space(6.0);
            ui.label(egui::RichText::new("File").strong());
            ui.add(egui::Label::new(&data.label).wrap());
        } else if let Some(t) = geomarmot_core::transformers::by_id(&data.node.kind) {
            ui.label(muted(t.summary()));
            // Only when it is not lon/lat, as the JavaScript inspector.
            if let Some((_, Some((_, crs)))) = upstream.first()
                && !crs.is_empty()
                && !geomarmot_core::is_lonlat(crs)
            {
                ui.label(egui::RichText::new(format!("Coordinates here are {crs}")).color(colour::HIGHLIGHT));
            }
            if t.params().is_empty() {
                ui.add_space(6.0);
                ui.label(muted("No parameters."));
            }
            let outcome = crate::form::show(ui, node, t.params(), &mut data.node.params, &columns);
            if outcome.changed {
                self.viewer.stale.push(node);
            }
            fill = outcome.fill;
        }
        ui.add_space(10.0);
        if ui
            .button(egui::RichText::new("▶ Run to here").color(colour::ACCENT))
            .on_hover_text("Run this node and what it depends on, and cache the result")
            .clicked()
        {
            self.viewer.run_to = Some(node);
        }
        if let Some((param, column)) = fill
            && let Some((_, Some((view, _)))) = upstream.first()
        {
            let c = geomarmot_core::qid(&column);
            self.send(Job::Rows {
                key: format!("fill:{node}:{param}"),
                sql: format!("SELECT DISTINCT {c}::VARCHAR FROM {view} WHERE {c} IS NOT NULL ORDER BY 1 LIMIT 100"),
            });
        }
    }

    /// The double-clicked node's editor, as a pop-up over the window.
    fn form_popup(&mut self, ctx: &egui::Context) {
        if let Some(node) = self.viewer.open_form.take() {
            self.form_open = Some(node);
            self.viewer.selected = Some((node, 0));
        }
        let Some(node) = self.form_open else { return };
        let mut close = false;
        let response = egui::Modal::new(egui::Id::new("node-form")).show(ctx, |ui| {
            ui.set_width(480.0);
            egui::ScrollArea::vertical()
                .max_height(ctx.content_rect().height() * 0.7)
                .show(ui, |ui| self.node_form(ui, node));
            ui.separator();
            ui.horizontal(|ui| {
                if ui.button("Close").clicked() {
                    close = true;
                }
            });
        });
        if close || response.should_close() || self.snarl.get_node(egui_snarl::NodeId(node)).is_none() {
            self.form_open = None;
        }
    }

    /// Over the canvas, with no text field focused: a letter or a double-click opens the
    /// transformer search; Delete or Backspace removes the selected node.
    fn canvas_keys(&mut self, ctx: &egui::Context, canvas: &egui::Response) {
        // Double-clicks, timed here: egui does not report them over a node's body, nor for
        // the wheel. Wheel: fit the view to all nodes. Left: a node's parameters in a pop-up,
        // or on empty canvas the transformer search.
        let area = self.viewer.canvas.unwrap_or(canvas.rect);
        let presses = ctx.input(|i| {
            i.events
                .iter()
                .filter_map(|e| match e {
                    egui::Event::PointerButton {
                        pos,
                        button: button @ (egui::PointerButton::Middle | egui::PointerButton::Primary),
                        pressed: true,
                        ..
                    } if area.contains(*pos) => Some((*button, i.time, *pos)),
                    _ => None,
                })
                .collect::<Vec<_>>()
        });
        let busy = self.quick.is_some() || self.form_open.is_some() || self.info.is_some();
        for (button, time, pos) in presses {
            // A click on empty canvas (no node, its buttons or ports) clears the selection, so a
            // node added next stands alone.
            let on_node = self.viewer.node_rects.iter().any(|(n, r)| {
                (self.viewer.to_global * *r).expand(30.0).contains(pos)
                    && self.snarl.get_node(egui_snarl::NodeId(*n)).is_some()
            });
            if button == egui::PointerButton::Primary && !busy && !on_node {
                self.viewer.selected = None;
                self.viewer.tabs.clear();
            }
            match self.last_press {
                Some((b, t, p)) if b == button && time - t < 0.4 && p.distance(pos) < 6.0 => {
                    self.last_press = None;
                    if button == egui::PointerButton::Middle {
                        self.viewer.fit = true;
                    } else if !busy {
                        let hit = self.viewer.node_rects.iter().find(|(n, r)| {
                            (self.viewer.to_global * *r).contains(pos)
                                && self.snarl.get_node(egui_snarl::NodeId(*n)).is_some()
                        });
                        match hit {
                            Some((n, _)) => self.viewer.open_form = Some(*n),
                            None => {
                                self.quick_link = crate::links::wire_at(&self.viewer, &self.snarl, pos);
                                self.quick = Some(crate::quickadd::QuickAdd::new("", pos));
                            }
                        }
                    }
                    ctx.request_repaint();
                }
                _ => self.last_press = Some((button, time, pos)),
            }
        }
        if let Some(quick) = &mut self.quick {
            if let Some(pick) = quick.show(ctx) {
                if let Some(kind) = pick
                    && PALETTE.contains(&kind)
                {
                    let pos = self.viewer.to_global.inverse() * quick.at;
                    let node = self.snarl.insert_node(pos, from_palette(kind));
                    let from = self.viewer.selected.take();
                    self.link_new(node, from);
                    self.viewer.selected = Some((node.0, 0));
                }
                self.quick = None;
                self.quick_link = None;
            }
            return;
        }
        if ctx.memory(|m| m.focused().is_some()) {
            return;
        }
        let pointer = ctx.pointer_hover_pos().filter(|p| area.contains(*p));
        let (typed, delete) = ctx.input(|i| {
            let typed = i.events.iter().find_map(|e| match e {
                egui::Event::Text(t) if t.chars().all(|c| c.is_ascii_alphanumeric()) => Some(t.clone()),
                _ => None,
            });
            let delete = i.key_pressed(egui::Key::Delete) || i.key_pressed(egui::Key::Backspace);
            (typed, delete)
        });
        if let (Some(t), Some(at)) = (typed, pointer) {
            self.quick_link = crate::links::wire_at(&self.viewer, &self.snarl, at);
            self.quick = Some(crate::quickadd::QuickAdd::new(&t, at));
        } else if delete && let Some((node, _)) = self.viewer.selected {
            self.remove_node(node);
        }
    }

    /// Remove a node; what it fed loses its results.
    fn remove_node(&mut self, node: usize) {
        let id = egui_snarl::NodeId(node);
        if self.snarl.get_node(id).is_some() {
            self.viewer.stale.extend(crate::canvas::downstream(&self.snarl, node));
            self.snarl.remove_node(id);
        }
        if self.viewer.selected.is_some_and(|(n, _)| n == node) {
            self.viewer.selected = None;
        }
    }

    /// A node added by typing: into the link under the pointer, else after the selected output.
    fn link_new(&mut self, node: egui_snarl::NodeId, from: Option<(usize, usize)>) {
        use egui_snarl::ui::SnarlViewer;
        use egui_snarl::{InPinId, OutPinId};
        let (inputs, outputs) = geomarmot_core::graph::ports(&self.snarl[node].node);
        if inputs.is_empty() {
            return;
        }
        let input = self.snarl.in_pin(InPinId { node, input: 0 });
        if let Some((o, i)) = self.quick_link.take() {
            if !outputs.is_empty() {
                self.snarl.disconnect(o, i);
                let out = self.snarl.out_pin(OutPinId { node, output: 0 });
                self.viewer.connect(&out, &self.snarl.in_pin(i), &mut self.snarl);
            }
            self.viewer.connect(&self.snarl.out_pin(o), &input, &mut self.snarl);
        } else if let Some((n, output)) = from
            && self.snarl.get_node(egui_snarl::NodeId(n)).is_some()
        {
            let out = self.snarl.out_pin(OutPinId {
                node: egui_snarl::NodeId(n),
                output,
            });
            self.viewer.connect(&out, &input, &mut self.snarl);
        }
    }

    /// Attributes on the left, geometry on the right, as the JavaScript dock.
    fn results(&mut self, ui: &mut egui::Ui) {
        self.tab_strip(ui);
        let muted = |t: String| egui::RichText::new(t).small().color(colour::MUTED);
        let view = self.selected_view();
        let table = match &self.shown {
            Some((v, Ok(t))) if Some(v) == view.as_ref() => Some(t),
            _ => None,
        };
        let message = match (&self.shown, table) {
            (_, Some(_)) => None,
            (Some((_, Err(e))), _) if view.is_some() => Some(e.clone()),
            _ if self
                .viewer
                .selected
                .is_some_and(|(n, _)| self.viewer.running.contains(&n)) =>
            {
                Some("Running…".to_string())
            }
            _ if self.viewer.selected.is_some() => Some("Not run yet. Press Run, or ▶ on the node.".to_string()),
            _ => Some("Select a node.".to_string()),
        };
        let features = match (&self.features, &view) {
            (Some((v, f)), Some(view)) if v == view => Some(f.as_slice()),
            _ => None,
        };
        let mut action = None;
        ui.columns(2, |cols| {
            cols[0].horizontal(|ui| {
                ui.label(egui::RichText::new("Attributes").size(16.0));
                match (&message, table) {
                    (Some(m), _) => {
                        if m.starts_with("Reading") || m.starts_with("Running") {
                            ui.add(egui::Spinner::new().size(12.0));
                        }
                        ui.label(muted(m.clone()));
                    }
                    (None, Some(t)) => {
                        let last = (t.offset + t.rows.len()).min(t.total);
                        let mut text = format!(
                            "{}–{} of {} rows",
                            thousands((t.offset + 1).min(last) as u64),
                            thousands(last as u64),
                            thousands(t.total as u64)
                        );
                        if t.geometry.is_some() {
                            text.push_str(" · geometry hidden here, see the map");
                        }
                        ui.label(muted(text));
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui.add_enabled(last < t.total, egui::Button::new("›")).clicked() {
                                action = Some(Action::Page(t.offset + PAGE));
                            }
                            if ui.add_enabled(t.offset > 0, egui::Button::new("‹")).clicked() {
                                action = Some(Action::Page(t.offset.saturating_sub(PAGE)));
                            }
                        });
                    }
                    _ => {}
                }
            });
            cols[0].separator();
            cols[1].horizontal(|ui| {
                ui.label(egui::RichText::new("Geometry").size(16.0));
                if let (Some(f), Some(t)) = (features, table) {
                    let capped = f.len() == MAP_LIMIT && t.total > MAP_LIMIT;
                    ui.label(muted(if capped {
                        format!(
                            "{} of {} features (capped at {})",
                            thousands(f.len() as u64),
                            thousands(t.total as u64),
                            thousands(MAP_LIMIT as u64)
                        )
                    } else {
                        format!("{} features", thousands(f.len() as u64))
                    }));
                }
            });
            cols[1].separator();
            if let Some(t) = table
                && let Some(a) = Self::table(&mut cols[0], t, self.picked.as_ref().map(|r| r.id))
            {
                action = Some(a);
            }
            let picked = self.picked.as_ref().and_then(|r| Some((r.id, r.shape.as_ref()?)));
            let empty = match (&message, &view) {
                (Some(m), Some(_)) if m.starts_with("Reading") => "Reading…",
                (Some(m), _) if m.starts_with("Running") => "Running…",
                (Some(m), _) if m.starts_with("Not run") => "Not run yet",
                _ => "Select a node",
            };
            self.map
                .show(&mut cols[1], view.as_deref().zip(features), picked, empty);
        });
        match action {
            Some(Action::Page(offset)) => self.offset = offset,
            Some(Action::Pick(row)) => {
                if let Some(shape) = &row.shape {
                    self.map.zoom_to(shape);
                }
                self.picked = Some(row);
            }
            Some(Action::Info(row)) => self.info = Some(row),
            Some(Action::Copied(what)) => self.status = format!("Copied {what}."),
            None => {}
        }
        self.info_window(ui.ctx());
    }

    /// The attribute table: ⓘ for the whole row, a copy button on the hovered cell, and a
    /// click on a row picks it (zoom and highlight on the map).
    fn table(ui: &mut egui::Ui, table: &Table, picked: Option<i64>) -> Option<Action> {
        use egui_extras::{Column, TableBuilder};
        let mut action = None;
        egui::ScrollArea::horizontal().show(ui, |ui| {
            TableBuilder::new(ui)
                .striped(true)
                .sense(egui::Sense::click())
                .column(Column::exact(22.0))
                .columns(
                    Column::auto().clip(true).at_least(60.0).at_most(260.0),
                    table.columns.len(),
                )
                .header(20.0, |mut h| {
                    h.col(|_| {});
                    for (name, kind) in table.columns.iter().zip(&table.kinds) {
                        h.col(|ui| {
                            ui.strong(name).on_hover_text(kind);
                        });
                    }
                })
                .body(|body| {
                    body.rows(20.0, table.rows.len(), |mut row| {
                        let r = &table.rows[row.index()];
                        row.set_selected(picked == Some(r.id));
                        row.col(|ui| {
                            if ui
                                .add(egui::Button::new(egui::RichText::new("ℹ").color(colour::MUTED)).frame(false))
                                .on_hover_text("All attributes")
                                .clicked()
                            {
                                action = Some(Action::Info(r.clone()));
                            }
                        });
                        for (cell, name) in r.cells.iter().zip(&table.columns) {
                            row.col(|ui| {
                                ui.add(egui::Label::new(cell).truncate().selectable(false));
                                let rect = ui.max_rect();
                                if ui.rect_contains_pointer(rect) {
                                    let at = Rect::from_min_size(
                                        rect.right_top() - egui::vec2(20.0, 0.0),
                                        egui::vec2(20.0, rect.height()),
                                    );
                                    if ui
                                        .put(at, egui::Button::new("🗐").small())
                                        .on_hover_text(format!("Copy {name}"))
                                        .clicked()
                                    {
                                        ui.ctx().copy_text(cell.clone());
                                        action = Some(Action::Copied(name.clone()));
                                    }
                                }
                            });
                        }
                        if row.response().clicked() && action.is_none() {
                            action = Some(Action::Pick(r.clone()));
                        }
                    });
                });
        });
        action
    }

    /// Every attribute of one row, each with a copy button (the ⓘ in the table).
    fn info_window(&mut self, ctx: &egui::Context) {
        let Some(row) = &self.info else { return };
        let Some((_, Ok(table))) = &self.shown else { return };
        let mut open = true;
        let mut copied = None;
        egui::Window::new(format!("Row {}", row.id + 1))
            .open(&mut open)
            .default_width(560.0)
            .collapsible(false)
            .show(ctx, |ui| {
                egui::ScrollArea::vertical().max_height(420.0).show(ui, |ui| {
                    egui::Grid::new("info")
                        .striped(true)
                        .num_columns(3)
                        .min_col_width(40.0)
                        .max_col_width(380.0)
                        .show(ui, |ui| {
                            for (name, value) in table.columns.iter().zip(&row.cells) {
                                ui.strong(name);
                                ui.add(egui::Label::new(value).wrap());
                                if ui.small_button("🗐").on_hover_text("Copy").clicked() {
                                    ctx.copy_text(value.clone());
                                    copied = Some(name.clone());
                                }
                                ui.end_row();
                            }
                        });
                });
                ui.separator();
                if ui.button("Copy all as JSON").clicked() {
                    let all: serde_json::Map<String, serde_json::Value> = table
                        .columns
                        .iter()
                        .cloned()
                        .zip(row.cells.iter().map(|c| serde_json::Value::String(c.clone())))
                        .collect();
                    ctx.copy_text(serde_json::to_string_pretty(&all).unwrap_or_default());
                    copied = Some("all attributes".into());
                }
            });
        if let Some(what) = copied {
            self.status = format!("Copied {what}.");
        }
        if !open {
            self.info = None;
        }
    }
}

/// What a click in the results asked for.
enum Action {
    Page(usize),
    Pick(Row),
    Info(Row),
    Copied(String),
}

/// Light paper theme with the JavaScript app's tokens.
fn apply_theme(ctx: &egui::Context) {
    // Map tiles load through egui's image loaders (http + png).
    egui_extras::install_image_loaders(ctx);
    ctx.set_theme(egui::Theme::Light);
    ctx.style_mut_of(egui::Theme::Light, |style| {
        let v = &mut style.visuals;
        v.panel_fill = egui::Color32::WHITE;
        v.window_fill = egui::Color32::WHITE;
        v.extreme_bg_color = colour::PAPER_1;
        v.faint_bg_color = colour::PAPER_2;
        v.override_text_color = Some(colour::INK);
        // Pale orange, as the JavaScript table's picked row; text stays readable.
        v.selection.bg_fill = egui::Color32::from_rgb(0xf6, 0xe3, 0xc6);
        v.selection.stroke = egui::Stroke::new(1.0, colour::INK);
        v.hyperlink_color = colour::ACCENT;
        v.widgets.noninteractive.bg_stroke = egui::Stroke::new(1.0, colour::BORDER);
        v.widgets.hovered.weak_bg_fill = colour::PAPER_2;
        v.widgets.hovered.bg_stroke = egui::Stroke::new(1.0, colour::ACCENT_SOFT);
    });
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        self.now = ui.input(|i| i.time);
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
            .exact_size(42.0)
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
                let canvas =
                    SnarlWidget::new()
                        .style(crate::canvas::style())
                        .show(&mut self.snarl, &mut self.viewer, ui);
                self.canvas_keys(ui.ctx(), &canvas);
                let hovering = ui.ctx().input(|i| !i.raw.hovered_files.is_empty());
                if self.quick.is_none() && (hovering || self.snarl.node_ids().next().is_none()) {
                    let text = if hovering {
                        "Drop to open"
                    } else {
                        "Drop a file here, or start typing to add a transformer"
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
        self.form_popup(&ui.ctx().clone());
        let stale = std::mem::take(&mut self.viewer.stale);
        if !stale.is_empty() {
            self.invalidate(stale);
        }
        if let Some(node) = self.viewer.run_to.take() {
            self.run(Some(vec![node]));
        }
        if let Some(node) = self.viewer.delete.take() {
            self.remove_node(node);
        }
    }
}
