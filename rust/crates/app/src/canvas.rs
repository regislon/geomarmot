//! The node canvas (egui-snarl): nodes are transformers, wires are edges.

use egui::{Color32, Ui};
use egui_snarl::ui::{PinInfo, SnarlPin, SnarlViewer};
use egui_snarl::{InPin, OutPin, Snarl};
use geomarmot_core::graph::{Edge, Graph, Node, NodeState, ports};
use serde_json::{Value, json};

/// Transformers offered in the canvas menu, with starting params.
/// The transformers ported so far; new nodes start from their parameters' defaults.
pub const PALETTE: &[&str] = &[
    "AttributeFilter",
    "Bufferer",
    "Dissolver",
    "Reprojector",
    "FeatureJoiner",
    "AreaOnAreaOverlayer",
    "MinimumBoundingCircle",
    "H3GeometryFromIndex",
    "DensifyFeatures",
    "MergeLineSegments",
    "SimplifyFeatures",
    "SmoothVectors",
    "VertexCreator",
    "H3GeometryFromPosition",
    "PolygonToH3",
    "PositionalH3Index",
];

/// Width of a node's title: every node is as wide.
const TITLE_WIDTH: f32 = 170.0 * Z;

/// The canvas is laid out at this zoom and only ever shrunk, so text stays sharp when zoomed in
/// (snarl's crisp_magnified_text). Sizes in canvas code are multiplied by it.
pub const Z: f32 = 2.0;

/// The JavaScript app's toolbox, in its order (transformers/index.js). Only the entries in
/// `PALETTE` are ported; the rest are shown disabled.
pub const CATALOGUE: &[(&str, &[&str])] = &[
    ("Source", &["Reader"]),
    (
        "Attributes",
        &[
            "AttributeManager",
            "AttributeCreator",
            "AttributeRenamer",
            "AttributeRemover",
            "AttributeKeeper",
        ],
    ),
    (
        "Filters",
        &["DuplicateFilter", "TestFilter", "AttributeFilter", "Tester"],
    ),
    ("Combine", &["AreaOnAreaOverlayer", "Unioner", "FeatureJoiner"]),
    (
        "Reshape",
        &[
            "SQLTransformer",
            "Sampler",
            "BoundingBoxReplacer",
            "Bufferer",
            "Dissolver",
            "StatisticsCalculator",
            "Aggregator",
            "Sorter",
        ],
    ),
    (
        "Geometry",
        &[
            "SmoothVectors",
            "DensifyFeatures",
            "MinimumBoundingCircle",
            "MinimumBoundingBox",
            "EliminateCoincidentPoints",
            "MergeLineSegments",
            "SimplifyFeatures",
            "MinimumConvexHull",
            "RepresentativePointVector",
            "CentroidVector",
            "CoordinateSystemSetter",
            "Reprojector",
            "VertexCreator",
        ],
    ),
    (
        "Analysis",
        &[
            "AddGeometryAttributes",
            "AttributeCorrelation",
            "AttributeHistogram",
            "FilterVectorFeaturesByArea",
            "ListUniqueValues",
        ],
    ),
    (
        "H3",
        &[
            "H3GeometryFromIndex",
            "H3GeometryFromPosition",
            "PolygonToH3",
            "PositionalH3Index",
        ],
    ),
    ("Output", &["Writer"]),
];

/// The JavaScript app's colour tokens (app/src/styles/base.css).
pub mod colour {
    use egui::Color32;
    pub const INK_DEEP: Color32 = Color32::from_rgb(0x16, 0x13, 0x0f);
    pub const INK: Color32 = Color32::from_rgb(0x2a, 0x24, 0x1d);
    pub const ACCENT: Color32 = Color32::from_rgb(0x3f, 0x7d, 0x5a);
    pub const ACCENT_SOFT: Color32 = Color32::from_rgb(0x7f, 0xae, 0x8c);
    pub const HIGHLIGHT: Color32 = Color32::from_rgb(0xd9, 0x91, 0x3a);
    pub const BLUE: Color32 = Color32::from_rgb(0x3d, 0x6a, 0x86);
    pub const BLUE_SOFT: Color32 = Color32::from_rgb(0x6f, 0x96, 0xad);
    pub const PAPER_1: Color32 = Color32::from_rgb(0xfb, 0xfa, 0xf7);
    pub const PAPER_2: Color32 = Color32::from_rgb(0xf2, 0xf0, 0xea);
    pub const PAPER_3: Color32 = Color32::from_rgb(0xe7, 0xe4, 0xdc);
    pub const ERR: Color32 = Color32::from_rgb(0xc0, 0x56, 0x3f);
    pub const BORDER: Color32 = Color32::from_rgb(0xd8, 0xd8, 0xd0);
    pub const MUTED: Color32 = Color32::from_rgb(0x6d, 0x7a, 0x70);
}

/// The header colour of a node, by its toolbox group (app/src/styles/canvas.css).
fn header_colour(kind: &str) -> Color32 {
    let group = CATALOGUE.iter().find(|(_, ids)| ids.contains(&kind)).map(|(g, _)| *g);
    match group {
        Some("Source" | "H3") => colour::BLUE,
        Some("Attributes") => colour::ACCENT,
        Some("Filters") => colour::HIGHLIGHT,
        Some("Reshape") => colour::ACCENT_SOFT,
        Some("Output") => colour::INK,
        _ => colour::BLUE_SOFT,
    }
}

/// The canvas look, as the JavaScript canvas: paper with dots, rounded white nodes.
pub fn style() -> egui_snarl::ui::SnarlStyle {
    let mut style = egui_snarl::ui::SnarlStyle::new();
    style.bg_frame = Some(egui::Frame::new().fill(colour::PAPER_2));
    style.wire_width = Some(2.0);
    // Double-click opens the transformer search (or a node's parameters) instead of re-centring.
    style.centering = Some(false);
    style.collapsible = Some(false);
    style.header_drag_space = Some(egui::Vec2::ZERO);
    style.pin_size = Some(10.0);
    // Ports sit on the node's edge, half outside, as in the JavaScript canvas.
    style.pin_placement = Some(egui_snarl::ui::PinPlacement::Edge);
    style.crisp_magnified_text = Some(true);
    style.max_scale = Some(Z);
    style
}

/// Dark green of run outputs and wires (the JavaScript canvas' ports).
const PORT: Color32 = Color32::from_rgb(0x2f, 0x5f, 0x43);

/// "output" → "Output", "unjoined_left" → "Unjoined left".
fn port_label(name: &str) -> String {
    let name = name.replace('_', " ");
    let mut c = name.chars();
    c.next()
        .map(|f| f.to_uppercase().chain(c).collect())
        .unwrap_or_default()
}

/// A new node of a ported transformer, with its default parameters.
pub fn from_palette(kind: &str) -> NodeData {
    let params = geomarmot_core::transformers::by_id(kind).map_or(json!({}), geomarmot_core::default_params);
    NodeData::new(kind, params, String::new())
}

pub struct NodeData {
    pub node: Node,
    pub label: String,
    pub state: Option<NodeState>,
}

impl NodeData {
    pub fn new(kind: &str, params: Value, label: String) -> Self {
        Self {
            node: Node {
                kind: kind.into(),
                params,
            },
            label,
            state: None,
        }
    }

    pub fn reader(relation: &str, label: &str) -> Self {
        Self::new("Reader", json!({ "relation": relation }), label.into())
    }
}

/// `node` and every node fed by it, directly or not.
pub fn downstream(snarl: &Snarl<NodeData>, node: usize) -> Vec<usize> {
    let mut found = vec![node];
    let mut i = 0;
    while i < found.len() {
        let n = found[i];
        for (o, input) in snarl.wires() {
            if o.node.0 == n && !found.contains(&input.node.0) {
                found.push(input.node.0);
            }
        }
        i += 1;
    }
    found
}

/// The graph the compiler sees.
pub fn to_graph(snarl: &Snarl<NodeData>) -> Graph {
    let nodes = snarl.node_ids().map(|(id, d)| (id.0, d.node.clone())).collect();
    let edges = snarl
        .wires()
        .map(|(o, i)| Edge {
            from: o.node.0,
            from_port: o.output,
            to: i.node.0,
            to_port: i.input,
        })
        .collect();
    Graph { nodes, edges }
}

#[derive(Default)]
pub struct Viewer {
    /// Nodes edited since they ran: they and everything downstream lose their results.
    pub stale: Vec<usize>,
    /// ▶ clicked on this node: run it and what it depends on.
    pub run_to: Option<usize>,
    /// A node double-clicked: its parameters open in a pop-up.
    pub open_form: Option<usize>,
    /// (node, output port) whose rows the table and map show.
    pub selected: Option<(usize, usize)>,
    /// Outputs open as tabs over the table (Alt-click an eye to add one); `selected` is the active one.
    pub tabs: Vec<(usize, usize)>,
    /// Graph to screen, and the canvas on screen: where new nodes go.
    pub to_global: egui::emath::TSTransform,
    pub canvas: Option<egui::Rect>,
    /// Fit the view to all nodes on the next frame.
    pub fit: bool,
    /// Where each node was drawn last frame, in graph coordinates (double-click hit test).
    pub node_rects: Vec<(usize, egui::Rect)>,
    /// Nodes in the run in progress (a spinner in their header).
    pub running: std::collections::BTreeSet<usize>,
    /// Row count of each run output, by view.
    pub counts: std::collections::BTreeMap<String, u64>,
    started: bool,
}

impl Viewer {
    /// A free spot in the visible canvas for the next of `count` nodes, in graph coordinates.
    pub fn place(&self, count: usize) -> egui::Pos2 {
        let (col, row) = ((count % 4) as f32, (count / 4 % 5) as f32);
        let screen =
            self.canvas.map_or(egui::Pos2::ZERO, |r| r.min) + egui::vec2(40.0 + 220.0 * col, 40.0 + 110.0 * row);
        self.to_global.inverse() * screen
    }
}

impl SnarlViewer<NodeData> for Viewer {
    fn title(&mut self, node: &NodeData) -> String {
        if node.label.is_empty() {
            node.node.kind.clone()
        } else {
            format!("{} · {}", node.node.kind, node.label)
        }
    }

    fn node_frame(
        &mut self,
        default: egui::Frame,
        node: egui_snarl::NodeId,
        _inputs: &[InPin],
        _outputs: &[OutPin],
        snarl: &Snarl<NodeData>,
    ) -> egui::Frame {
        let failed = matches!(snarl[node].state, Some(NodeState::Error(_)));
        let selected = self.selected.map(|(n, _)| n) == Some(node.0);
        let stroke = match (failed, selected) {
            // A failed node gets a dashed red outline instead (final_node_rect).
            (true, _) => egui::Stroke::NONE,
            (_, true) => egui::Stroke::new(2.0 * Z, colour::ACCENT),
            _ => egui::Stroke::new(Z, colour::BORDER),
        };
        default
            .fill(Color32::WHITE)
            .stroke(stroke)
            .corner_radius(6.0 * Z)
            .inner_margin(egui::Margin {
                left: 16,
                right: 16,
                top: 0,
                bottom: 8,
            })
            .shadow(egui::Shadow {
                offset: [0, 2],
                blur: 6,
                spread: 0,
                color: Color32::from_black_alpha(18),
            })
    }

    fn header_frame(
        &mut self,
        default: egui::Frame,
        node: egui_snarl::NodeId,
        _inputs: &[InPin],
        _outputs: &[OutPin],
        snarl: &Snarl<NodeData>,
    ) -> egui::Frame {
        default
            .fill(header_colour(&snarl[node].node.kind))
            .corner_radius(egui::CornerRadius {
                nw: 12,
                ne: 12,
                sw: 0,
                se: 0,
            })
            .inner_margin(egui::Margin::symmetric(20, 10))
    }

    fn show_header(
        &mut self,
        node: egui_snarl::NodeId,
        _inputs: &[InPin],
        outputs: &[OutPin],
        ui: &mut Ui,
        snarl: &mut Snarl<NodeData>,
    ) {
        let data = &snarl[node];
        let title = egui::RichText::new(&data.node.kind)
            .size(15.0 * Z)
            .strong()
            .color(Color32::WHITE);
        let hover = if data.label.is_empty() {
            data.node.kind.clone()
        } else {
            format!("{} · {}", data.node.kind, data.label)
        };
        // Same width for every node; the title on the left, the state on the right.
        let clicked = ui
            .allocate_ui_with_layout(
                egui::vec2(TITLE_WIDTH, 20.0 * Z),
                egui::Layout::left_to_right(egui::Align::Center),
                |ui| {
                    ui.set_width(TITLE_WIDTH);
                    let title = ui
                        .add(egui::Label::new(title).truncate().sense(egui::Sense::click()))
                        .on_hover_text(hover);
                    if self.running.contains(&node.0) {
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            ui.add(egui::Spinner::new().size(12.0 * Z).color(Color32::WHITE))
                                .on_hover_text("Running…");
                        });
                    } else if let Some(NodeState::Error(e)) = &data.state {
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            ui.label(egui::RichText::new("!").strong().color(Color32::WHITE))
                                .on_hover_text(e);
                        });
                    }
                    title
                },
            )
            .inner;
        if clicked.clicked() {
            self.selected = (!outputs.is_empty()).then_some((node.0, 0));
        }
    }

    /// Hover outline, the dashed red outline of a failed node, and ▶ Run to here floating
    /// above the hovered or selected node.
    fn final_node_rect(
        &mut self,
        node: egui_snarl::NodeId,
        rect: egui::Rect,
        ui: &mut Ui,
        snarl: &mut Snarl<NodeData>,
    ) {
        self.node_rects.retain(|(n, _)| *n != node.0);
        self.node_rects.push((node.0, rect));
        let selected = self.selected.map(|(n, _)| n) == Some(node.0);
        let run = egui::Rect::from_min_size(
            rect.right_top() + Z * egui::vec2(-30.0, -28.0),
            Z * egui::vec2(30.0, 24.0),
        );
        let hovered = ui.rect_contains_pointer(rect.union(run));
        if matches!(snarl[node].state, Some(NodeState::Error(_))) {
            let r = rect.expand(2.0 * Z);
            let corners = [
                r.left_top(),
                r.right_top(),
                r.right_bottom(),
                r.left_bottom(),
                r.left_top(),
            ];
            ui.painter().extend(egui::Shape::dashed_line(
                &corners,
                egui::Stroke::new(1.5 * Z, colour::ERR),
                5.0 * Z,
                3.0 * Z,
            ));
        } else if !selected && hovered {
            ui.painter().rect_stroke(
                rect,
                8.0 * Z,
                egui::Stroke::new(2.0 * Z, colour::ACCENT_SOFT),
                egui::StrokeKind::Outside,
            );
        }
        if hovered || selected {
            let button = egui::Button::new(egui::RichText::new("▶").color(PORT)).corner_radius(12.0 * Z);
            if ui
                .put(run, button)
                .on_hover_text("Run to here and cache the result")
                .clicked()
            {
                self.run_to = Some(node.0);
            }
        }
    }

    /// Dots every 18 points, as the JavaScript canvas (thinned out when zoomed far out).
    fn draw_background(
        &mut self,
        _background: Option<&egui_snarl::ui::BackgroundPattern>,
        viewport: &egui::Rect,
        _snarl_style: &egui_snarl::ui::SnarlStyle,
        _style: &egui::Style,
        painter: &egui::Painter,
        _snarl: &Snarl<NodeData>,
    ) {
        let mut step = 18.0 * Z;
        while (viewport.width() / step) * (viewport.height() / step) > 12_000.0 {
            step *= 2.0;
        }
        let dot = Color32::from_rgb(0xcf, 0xca, 0xbe);
        let mut y = (viewport.top() / step).floor() * step;
        while y < viewport.bottom() {
            let mut x = (viewport.left() / step).floor() * step;
            while x < viewport.right() {
                painter.rect_filled(
                    egui::Rect::from_center_size(egui::pos2(x, y), egui::vec2(1.6 * Z, 1.6 * Z)),
                    0.0,
                    dot,
                );
                x += step;
            }
            y += step;
        }
    }

    fn current_transform(&mut self, to_global: &mut egui::emath::TSTransform, snarl: &mut Snarl<NodeData>) {
        if !self.started {
            // Laid out at Z (crisp text): start at 100 %.
            self.started = true;
            *to_global = egui::emath::TSTransform::from_scaling(1.0 / Z);
        }
        if std::mem::take(&mut self.fit)
            && let Some(canvas) = self.canvas
        {
            // ponytail: nodes taken as 220×110 from their top-left; use drawn rects if fit looks off.
            let bb = snarl
                .node_ids()
                .filter_map(|(id, _)| snarl.get_node_info(id))
                .fold(egui::Rect::NOTHING, |bb, n| {
                    bb.union(egui::Rect::from_min_size(n.pos, Z * egui::vec2(220.0, 110.0)))
                });
            if bb.is_finite() {
                let bb = bb.expand(40.0 * Z);
                let scaling = (canvas.width() / bb.width())
                    .min(canvas.height() / bb.height())
                    .clamp(0.2 / Z, 1.5 / Z);
                *to_global =
                    egui::emath::TSTransform::new(canvas.center().to_vec2() - scaling * bb.center().to_vec2(), scaling);
            }
        }
        self.to_global = *to_global;
    }

    fn inputs(&mut self, node: &NodeData) -> usize {
        ports(&node.node).0.len()
    }

    fn outputs(&mut self, node: &NodeData) -> usize {
        ports(&node.node).1.len()
    }

    fn show_input(&mut self, pin: &InPin, ui: &mut Ui, snarl: &mut Snarl<NodeData>) -> impl SnarlPin + 'static {
        let name = ports(&snarl[pin.id.node].node)
            .0
            .get(pin.id.input)
            .cloned()
            .unwrap_or_default();
        ui.label(egui::RichText::new(port_label(&name)).size(13.0 * Z).color(colour::INK));
        PinInfo::circle()
            .with_fill(Color32::WHITE)
            .with_stroke(egui::Stroke::new(1.5 * Z, PORT))
            .with_wire_color(PORT)
    }

    /// "Output 13,401 👁": the row count once it ran, and the eye that shows its rows.
    fn show_output(&mut self, pin: &OutPin, ui: &mut Ui, snarl: &mut Snarl<NodeData>) -> impl SnarlPin + 'static {
        let data = &snarl[pin.id.node];
        let name = ports(&data.node).1.get(pin.id.output).cloned().unwrap_or_default();
        let here = Some((pin.id.node.0, pin.id.output));
        let view = match &data.state {
            Some(NodeState::Ready { ports, .. }) => ports.get(pin.id.output).map(|(_, v)| v.clone()),
            _ => None,
        };
        // Output pins lay out right to left: added in reverse to read "Output 13,401 👁",
        // centred on one line (the eye is taller than the text).
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.add_space(4.0 * Z);
            let on = self.selected == here;
            let open = here.is_some_and(|h| self.tabs.contains(&h));
            let eye = egui::RichText::new("👁").size(22.0 * Z).color(match (on, open) {
                (true, _) => colour::HIGHLIGHT,
                (_, true) => colour::INK,
                _ => colour::MUTED,
            });
            if ui
                .add(egui::Button::new(eye).frame(false))
                .on_hover_text("Show its rows · Alt-click to add it as a tab")
                .clicked()
                && let Some(h) = here
            {
                if ui.input(|i| i.modifiers.alt) {
                    if open {
                        self.tabs.retain(|t| *t != h);
                        if on {
                            self.selected = self.tabs.last().copied();
                        }
                    } else {
                        self.tabs.push(h);
                        self.selected = here;
                    }
                } else {
                    self.tabs = vec![h];
                    self.selected = here;
                }
            }
            if let Some(n) = view.as_ref().and_then(|v| self.counts.get(v)) {
                ui.label(
                    egui::RichText::new(geomarmot_core::thousands(*n))
                        .size(13.0 * Z)
                        .strong()
                        .color(colour::INK),
                );
            }
            ui.label(egui::RichText::new(port_label(&name)).size(13.0 * Z).color(colour::INK));
        });
        let fill = if view.is_some() { PORT } else { colour::BORDER };
        PinInfo::circle()
            .with_fill(fill)
            .with_stroke(egui::Stroke::new(1.5 * Z, PORT))
            .with_wire_color(PORT)
    }

    fn has_graph_menu(&mut self, _pos: egui::Pos2, _snarl: &mut Snarl<NodeData>) -> bool {
        true
    }

    fn show_graph_menu(&mut self, pos: egui::Pos2, ui: &mut Ui, snarl: &mut Snarl<NodeData>) {
        ui.label("Add a transformer");
        for kind in PALETTE {
            if ui.button(*kind).clicked() {
                snarl.insert_node(pos, from_palette(kind));
                ui.close();
            }
        }
    }

    fn has_node_menu(&mut self, _node: &NodeData) -> bool {
        true
    }

    fn show_node_menu(
        &mut self,
        node: egui_snarl::NodeId,
        _inputs: &[InPin],
        _outputs: &[OutPin],
        ui: &mut Ui,
        snarl: &mut Snarl<NodeData>,
    ) {
        if ui.button("Remove").clicked() {
            self.stale.extend(downstream(snarl, node.0));
            snarl.remove_node(node);
            ui.close();
        }
    }

    fn connect(&mut self, from: &OutPin, to: &InPin, snarl: &mut Snarl<NodeData>) {
        snarl.drop_inputs(to.id);
        snarl.connect(from.id, to.id);
        self.stale.push(to.id.node.0);
    }

    fn disconnect(&mut self, from: &OutPin, to: &InPin, snarl: &mut Snarl<NodeData>) {
        snarl.disconnect(from.id, to.id);
        self.stale.push(to.id.node.0);
    }
}
