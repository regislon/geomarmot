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
];

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
        ui.label(name);
        PinInfo::circle().with_fill(Color32::from_rgb(120, 140, 200))
    }

    fn show_output(&mut self, pin: &OutPin, ui: &mut Ui, snarl: &mut Snarl<NodeData>) -> impl SnarlPin + 'static {
        let data = &snarl[pin.id.node];
        let name = ports(&data.node).1.get(pin.id.output).cloned().unwrap_or_default();
        let here = Some((pin.id.node.0, pin.id.output));
        if ui.selectable_label(self.selected == here, name).clicked() {
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
                snarl.insert_node(
                    pos,
                    NodeData::new(kind, serde_json::from_str(params).unwrap(), String::new()),
                );
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
