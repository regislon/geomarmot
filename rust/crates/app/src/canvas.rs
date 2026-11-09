//! The node canvas (egui-snarl): nodes are transformers, wires are edges.

use egui::{Color32, Ui};
use egui_snarl::ui::{PinInfo, SnarlPin, SnarlViewer};
use egui_snarl::{InPin, OutPin, Snarl};
use geomarmot_core::graph::{Edge, Graph, Node, NodeState, ports};
use serde_json::{Value, json};

/// Transformers offered in the canvas menu, with starting params.
pub const PALETTE: &[(&str, &str)] = &[
    ("AttributeFilter", r#"{"column": "", "values": []}"#),
    ("Bufferer", r#"{"distance": "1000", "crs": "azimuthal_equidistant"}"#),
    ("Dissolver", r#"{"groupBy": []}"#),
    ("Reprojector", r#"{"to": "EPSG:2056"}"#),
    (
        "FeatureJoiner",
        r#"{"joinType": "Inner", "keys": [{"left": "", "right": ""}]}"#,
    ),
    ("AreaOnAreaOverlayer", r#"{"accumulate": []}"#),
    ("MinimumBoundingCircle", "{}"),
    ("H3GeometryFromIndex", r#"{"indexColumn": "h3"}"#),
];

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

/// The canvas look: paper with a light grid, as the JavaScript canvas.
pub fn style() -> egui_snarl::ui::SnarlStyle {
    let mut style = egui_snarl::ui::SnarlStyle::new();
    style.bg_frame = Some(egui::Frame::new().fill(colour::PAPER_2));
    style.bg_pattern = Some(egui_snarl::ui::BackgroundPattern::grid(egui::vec2(18.0, 18.0), 0.0));
    style.bg_pattern_stroke = Some(egui::Stroke::new(1.0, colour::PAPER_3));
    style.wire_width = Some(2.0);
    style.pin_size = Some(9.0);
    style
}

/// A new node of a palette entry.
pub fn from_palette(kind: &str, params: &str) -> NodeData {
    NodeData::new(kind, serde_json::from_str(params).unwrap(), String::new())
}

pub struct NodeData {
    pub node: Node,
    pub label: String,
    /// The inspector edits params as JSON text; applied when it parses.
    pub text: String,
    pub state: Option<NodeState>,
}

impl NodeData {
    pub fn new(kind: &str, params: Value, label: String) -> Self {
        let text = serde_json::to_string_pretty(&params).unwrap_or_default();
        Self {
            node: Node {
                kind: kind.into(),
                params,
            },
            label,
            text,
            state: None,
        }
    }

    pub fn reader(relation: &str, label: &str) -> Self {
        Self::new("Reader", json!({ "relation": relation }), label.into())
    }
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
    pub changed: bool,
    /// (node, output port) whose rows the table and map show.
    pub selected: Option<(usize, usize)>,
    /// Graph to screen, and the canvas on screen: where new nodes go.
    pub to_global: egui::emath::TSTransform,
    pub canvas: Option<egui::Rect>,
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

fn state_colour(state: &Option<NodeState>) -> Color32 {
    match state {
        Some(NodeState::Ready { .. }) => Color32::from_rgb(90, 170, 110),
        Some(NodeState::Error(_)) => Color32::from_rgb(200, 80, 70),
        Some(NodeState::Blocked) => Color32::GRAY,
        None => Color32::LIGHT_GRAY,
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
            (true, _) => egui::Stroke::new(1.5, colour::ERR),
            (_, true) => egui::Stroke::new(2.0, colour::ACCENT),
            _ => egui::Stroke::new(1.0, colour::BORDER),
        };
        default
            .fill(Color32::WHITE)
            .stroke(stroke)
            .corner_radius(5)
            .inner_margin(0)
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
                nw: 5,
                ne: 5,
                sw: 0,
                se: 0,
            })
            .inner_margin(egui::Margin::symmetric(10, 6))
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
        let mut title = egui::RichText::new(self.title(data)).strong().color(Color32::WHITE);
        if matches!(data.state, Some(NodeState::Error(_))) {
            title = egui::RichText::new(format!("{}  !", self.title(data)))
                .strong()
                .color(Color32::WHITE);
        }
        let clicked = ui.add(egui::Label::new(title).sense(egui::Sense::click())).clicked();
        if clicked {
            self.selected = (!outputs.is_empty()).then_some((node.0, 0));
        }
    }

    fn current_transform(&mut self, to_global: &mut egui::emath::TSTransform, _snarl: &mut Snarl<NodeData>) {
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
        ui.label(egui::RichText::new(name).small().color(colour::MUTED));
        PinInfo::circle().with_fill(colour::ACCENT)
    }

    fn show_output(&mut self, pin: &OutPin, ui: &mut Ui, snarl: &mut Snarl<NodeData>) -> impl SnarlPin + 'static {
        let data = &snarl[pin.id.node];
        let name = ports(&data.node).1.get(pin.id.output).cloned().unwrap_or_default();
        let here = Some((pin.id.node.0, pin.id.output));
        let eye = if self.selected == here { "👁" } else { "◌" };
        if ui
            .selectable_label(
                self.selected == here,
                egui::RichText::new(format!("{name} {eye}")).small(),
            )
            .on_hover_text("Show its rows")
            .clicked()
        {
            self.selected = here;
        }
        PinInfo::circle().with_fill(state_colour(&data.state))
    }

    fn has_graph_menu(&mut self, _pos: egui::Pos2, _snarl: &mut Snarl<NodeData>) -> bool {
        true
    }

    fn show_graph_menu(&mut self, pos: egui::Pos2, ui: &mut Ui, snarl: &mut Snarl<NodeData>) {
        ui.label("Add a transformer");
        for (kind, params) in PALETTE {
            if ui.button(*kind).clicked() {
                snarl.insert_node(pos, from_palette(kind, params));
                self.changed = true;
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
            snarl.remove_node(node);
            self.changed = true;
            ui.close();
        }
    }

    fn connect(&mut self, from: &OutPin, to: &InPin, snarl: &mut Snarl<NodeData>) {
        snarl.drop_inputs(to.id);
        snarl.connect(from.id, to.id);
        self.changed = true;
    }

    fn disconnect(&mut self, from: &OutPin, to: &InPin, snarl: &mut Snarl<NodeData>) {
        snarl.disconnect(from.id, to.id);
        self.changed = true;
    }
}
