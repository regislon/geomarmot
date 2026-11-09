//! Links between nodes, beyond what the canvas library does: snapping a dropped link to the
//! nearest port, and finding the link under the pointer (to insert a new node into it).

use egui::Pos2;
use egui_snarl::ui::{AnyPins, SnarlViewer};
use egui_snarl::{InPinId, NodeId, OutPinId, Snarl};

use crate::canvas::{NodeData, Viewer, Z};

/// How far from a port, on screen, a dropped link still snaps to it.
const SNAP: f32 = 40.0;
/// How far from a link, on screen, the pointer still counts as on it.
const NEAR_WIRE: f32 = 10.0;

/// Where a port was drawn last frame, on screen: ports sit on the node's left or right edge.
fn pin_pos(v: &Viewer, output: bool, node: usize, port: usize) -> Option<Pos2> {
    let rect = v.node_rects.iter().find(|(n, _)| *n == node)?.1;
    let y = *v.pin_y.get(&(output, node, port))?;
    Some(v.to_global * egui::pos2(if output { rect.right() } else { rect.left() }, y))
}

/// The nearest port of the other kind within `SNAP` of the pointer, not on the dragged nodes.
fn nearest(v: &Viewer, output: bool, skip: &[usize]) -> Option<(usize, usize)> {
    let pointer = v.pointer?;
    v.pin_y
        .keys()
        .filter(|(o, n, _)| *o == output && !skip.contains(n))
        .filter_map(|&(o, n, p)| Some(((n, p), pin_pos(v, o, n, p)?.distance(pointer))))
        .filter(|(_, d)| *d < SNAP)
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(pin, _)| pin)
}

/// A link dropped near a port, not on it: connect it to that port.
pub fn snap(v: &mut Viewer, dragged: AnyPins, snarl: &mut Snarl<NodeData>) {
    match dragged {
        AnyPins::Out(outs) => {
            let skip: Vec<usize> = outs.iter().map(|o| o.node.0).collect();
            if let Some((n, input)) = nearest(v, false, &skip) {
                let to = snarl.in_pin(InPinId { node: NodeId(n), input });
                for o in outs {
                    v.connect(&snarl.out_pin(*o), &to, snarl);
                }
            }
        }
        AnyPins::In(ins) => {
            let skip: Vec<usize> = ins.iter().map(|i| i.node.0).collect();
            if let Some((n, output)) = nearest(v, true, &skip) {
                let from = snarl.out_pin(OutPinId {
                    node: NodeId(n),
                    output,
                });
                for i in ins {
                    v.connect(&from, &snarl.in_pin(*i), snarl);
                }
            }
        }
    }
}

/// The link under `pos` (screen), as drawn: a curve leaving and entering its ports horizontally.
// ponytail: a cubic Bézier stands in for the library's 5-point curve; close enough at NEAR_WIRE.
pub fn wire_at(v: &Viewer, snarl: &Snarl<NodeData>, pos: Pos2) -> Option<(OutPinId, InPinId)> {
    // The library bends links over three port widths (pin size 14, laid out at Z).
    let bend = 3.0 * 14.0 * Z * v.to_global.scaling;
    snarl.wires().find(|(o, i)| {
        let (Some(a), Some(d)) = (
            pin_pos(v, true, o.node.0, o.output),
            pin_pos(v, false, i.node.0, i.input),
        ) else {
            return false;
        };
        let (b, c) = (a + egui::vec2(bend, 0.0), d - egui::vec2(bend, 0.0));
        (0..=48).any(|k| {
            let t = k as f32 / 48.0;
            let u = 1.0 - t;
            let p = (u * u * u) * a.to_vec2()
                + (3.0 * u * u * t) * b.to_vec2()
                + (3.0 * u * t * t) * c.to_vec2()
                + (t * t * t) * d.to_vec2();
            p.to_pos2().distance(pos) < NEAR_WIRE
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_is_found_under_its_midpoint_only() {
        let mut snarl = Snarl::new();
        let a = snarl.insert_node(egui::Pos2::ZERO, crate::canvas::from_palette("Bufferer"));
        let b = snarl.insert_node(egui::Pos2::ZERO, crate::canvas::from_palette("Dissolver"));
        snarl.connect(OutPinId { node: a, output: 0 }, InPinId { node: b, input: 0 });
        let mut v = Viewer::default();
        v.node_rects = vec![
            (
                a.0,
                egui::Rect::from_min_size(egui::pos2(0.0, 0.0), egui::vec2(100.0, 50.0)),
            ),
            (
                b.0,
                egui::Rect::from_min_size(egui::pos2(400.0, 0.0), egui::vec2(100.0, 50.0)),
            ),
        ];
        v.pin_y.insert((true, a.0, 0), 30.0);
        v.pin_y.insert((false, b.0, 0), 30.0);
        assert!(wire_at(&v, &snarl, egui::pos2(250.0, 30.0)).is_some());
        assert!(wire_at(&v, &snarl, egui::pos2(250.0, 80.0)).is_none());
        // A link dropped 20 px from Dissolver's input connects to it.
        snarl.disconnect(OutPinId { node: a, output: 0 }, InPinId { node: b, input: 0 });
        v.pointer = Some(egui::pos2(385.0, 38.0));
        snap(&mut v, AnyPins::Out(&[OutPinId { node: a, output: 0 }]), &mut snarl);
        assert_eq!(snarl.wires().count(), 1);
    }
}
