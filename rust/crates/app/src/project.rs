//! Saving and opening a graph file (`*.flow.json`): the JavaScript app's `geomarmot-graph`
//! format (nodes with their position and params, edges by port name), plus bookmarks.
//! A Reader keeps the path of its file and opens it again on load.

use egui_snarl::{InPinId, NodeId, OutPinId, Snarl};
use geomarmot_core::graph::ports;
use serde_json::{Value, json};

use crate::bookmarks::Bookmark;
use crate::canvas::{NodeData, Z};

pub const FORMAT: &str = "geomarmot-graph";

/// The graph as a file. Positions are stored at 100 % zoom (the canvas lays out at `Z`).
pub fn save(snarl: &Snarl<NodeData>, bookmarks: &[Bookmark]) -> Value {
    let nodes: Vec<Value> = snarl
        .node_ids()
        .map(|(id, d)| {
            let pos = snarl.get_node_info(id).map_or(egui::Pos2::ZERO, |n| n.pos);
            let mut params = d.node.params.clone();
            // A table name of this session only; the path opens it again.
            if let Some(p) = params.as_object_mut() {
                p.remove("relation");
            }
            json!({ "id": format!("n{}", id.0), "type": d.node.kind, "x": pos.x / Z, "y": pos.y / Z,
                    "params": params, "label": d.label })
        })
        .collect();
    let edges: Vec<Value> = snarl
        .wires()
        .enumerate()
        .map(|(k, (o, i))| {
            let port = |node: NodeId, input: bool, k: usize| {
                let (ins, outs) = ports(&snarl[node].node);
                (if input { ins } else { outs }).get(k).cloned().unwrap_or_default()
            };
            json!({ "id": format!("e{}", k + 1), "from": format!("n{}", o.node.0), "fromPort": port(o.node, false, o.output),
                    "to": format!("n{}", i.node.0), "toPort": port(i.node, true, i.input) })
        })
        .collect();
    let bookmarks: Vec<Value> = bookmarks
        .iter()
        .map(|b| {
            json!({ "title": b.title, "colour": b.colour, "x": b.rect.min.x / Z, "y": b.rect.min.y / Z,
                    "width": b.rect.width() / Z, "height": b.rect.height() / Z })
        })
        .collect();
    json!({ "format": FORMAT, "version": 1, "nodes": nodes, "edges": edges, "bookmarks": bookmarks })
}

/// A graph file back to a canvas and its bookmarks.
pub fn load(saved: &Value) -> Result<(Snarl<NodeData>, Vec<Bookmark>), String> {
    if saved["format"] != FORMAT {
        return Err("This is not a GeoMarmot graph file.".into());
    }
    if saved["version"] != 1 {
        return Err(format!(
            "Graph format version {} is newer than this app.",
            saved["version"]
        ));
    }
    let num = |v: &Value| v.as_f64().unwrap_or(0.0) as f32;
    let mut snarl = Snarl::new();
    let mut ids = std::collections::HashMap::new();
    for n in saved["nodes"].as_array().into_iter().flatten() {
        let data = NodeData::new(
            n["type"].as_str().unwrap_or_default(),
            n["params"].clone(),
            n["label"].as_str().unwrap_or_default().into(),
        );
        let id = snarl.insert_node(Z * egui::pos2(num(&n["x"]), num(&n["y"])), data);
        ids.insert(n["id"].as_str().unwrap_or_default().to_string(), id);
    }
    for e in saved["edges"].as_array().into_iter().flatten() {
        let (Some(&from), Some(&to)) = (
            ids.get(e["from"].as_str().unwrap_or_default()),
            ids.get(e["to"].as_str().unwrap_or_default()),
        ) else {
            continue;
        };
        let output = ports(&snarl[from].node).1.iter().position(|p| e["fromPort"] == *p);
        let input = ports(&snarl[to].node).0.iter().position(|p| e["toPort"] == *p);
        if let (Some(output), Some(input)) = (output, input) {
            snarl.connect(OutPinId { node: from, output }, InPinId { node: to, input });
        }
    }
    let bookmarks = saved["bookmarks"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|b| Bookmark {
            title: b["title"].as_str().unwrap_or("Bookmark").into(),
            colour: b["colour"].as_u64().unwrap_or(0) as usize,
            rect: egui::Rect::from_min_size(
                Z * egui::pos2(num(&b["x"]), num(&b["y"])),
                Z * egui::vec2(num(&b["width"]), num(&b["height"])),
            ),
        })
        .collect();
    Ok((snarl, bookmarks))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_graph_opens_the_same() {
        let mut snarl = Snarl::new();
        let reader = snarl.insert_node(
            egui::pos2(20.0, 40.0),
            NodeData::new(
                "Reader",
                json!({ "relation": "t1", "path": "/data/a.geojson" }),
                "a.geojson".into(),
            ),
        );
        let buffer = snarl.insert_node(egui::pos2(400.0, 40.0), crate::canvas::from_palette("Bufferer"));
        snarl.connect(
            OutPinId {
                node: reader,
                output: 0,
            },
            InPinId { node: buffer, input: 0 },
        );
        let marks = vec![Bookmark {
            title: "Inputs".into(),
            colour: 2,
            rect: egui::Rect::from_min_size(egui::pos2(0.0, 0.0), egui::vec2(300.0, 200.0)),
        }];
        let file = save(&snarl, &marks);
        let (back, back_marks) = load(&file).unwrap();
        assert_eq!(back.node_ids().count(), 2);
        assert_eq!(back.wires().count(), 1);
        assert_eq!(back_marks[0].title, "Inputs");
        assert_eq!(back_marks[0].rect, marks[0].rect);
        let r = back.node_ids().find(|(_, d)| d.node.kind == "Reader").unwrap();
        assert_eq!(
            r.1.node.params,
            json!({ "path": "/data/a.geojson" }),
            "the path, not the table"
        );
        assert_eq!(back.get_node_info(r.0).unwrap().pos, egui::pos2(20.0, 40.0));
        assert!(load(&json!({ "format": "other" })).is_err());
    }

    #[test]
    fn a_database_reader_keeps_its_connection_name_only() {
        let mut snarl = Snarl::new();
        let source = json!({ "connection": "office-gis", "schema": "public", "table": "parcels", "crs": "EPSG:2056" });
        snarl.insert_node(
            egui::pos2(0.0, 0.0),
            NodeData::reader("src_3", "parcels (office-gis)", &source),
        );
        let file = save(&snarl, &[]);
        assert_eq!(
            file["nodes"][0]["params"], source,
            "no relation, no password, no server details"
        );
        let (back, _) = load(&file).unwrap();
        let (_, reader) = back.node_ids().next().unwrap();
        assert!(NodeData::same_source(&reader.node.params, &source));
        assert!(!NodeData::same_source(
            &reader.node.params,
            &json!({ "connection": "office-gis", "schema": "public", "table": "roads" })
        ));
    }
}
