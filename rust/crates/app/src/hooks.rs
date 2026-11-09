//! Browser test hooks: Playwright cannot see inside the egui canvas, so a test drives the app
//! through these calls, which do what the canvas gestures do (add, wire, select, export).

use std::cell::RefCell;

use egui_snarl::{InPinId, NodeId, OutPinId};
use serde_json::{Value, json};
use wasm_bindgen::prelude::wasm_bindgen;

use crate::app::App;
use crate::canvas::NodeData;

thread_local! {
    static COMMANDS: RefCell<Vec<Value>> = const { RefCell::new(Vec::new()) };
    static STATE: RefCell<String> = const { RefCell::new(String::new()) };
    static CTX: RefCell<Option<egui::Context>> = const { RefCell::new(None) };
}

/// Queue a command: `{add: kind, params, from: [node, port]}`, `{select: [node, port]}`, `{export: true}`.
#[wasm_bindgen]
pub fn app_command(command: String) {
    if let Ok(v) = serde_json::from_str(&command) {
        COMMANDS.with(|c| c.borrow_mut().push(v));
        // egui paints on demand: without this the command waits for the next input event.
        CTX.with(|c| c.borrow().as_ref().map(|ctx| ctx.request_repaint()));
    }
}

/// `{status, nodes, rows}` as of the last frame.
#[wasm_bindgen]
pub fn app_state() -> String {
    STATE.with(|s| s.borrow().clone())
}

pub fn run(app: &mut App, ctx: &egui::Context) {
    CTX.with(|c| *c.borrow_mut() = Some(ctx.clone()));
    for c in COMMANDS.with(|c| std::mem::take(&mut *c.borrow_mut())) {
        if let Some(kind) = c["add"].as_str() {
            let node = app.snarl.insert_node(
                egui::pos2(300.0, 200.0),
                NodeData::new(kind, c["params"].clone(), String::new()),
            );
            if let (Some(n), Some(p)) = (c["from"][0].as_u64(), c["from"][1].as_u64()) {
                app.snarl.connect(
                    OutPinId {
                        node: NodeId(n as usize),
                        output: p as usize,
                    },
                    InPinId { node, input: 0 },
                );
            }
            app.viewer.changed = true;
        }
        if let (Some(n), Some(p)) = (c["select"][0].as_u64(), c["select"][1].as_u64()) {
            app.viewer.selected = Some((n as usize, p as usize));
        }
        if c["export"].as_bool() == Some(true) {
            app.export("export.parquet".into());
        }
        ctx.request_repaint();
    }
    let state = json!({ "status": app.status(), "nodes": app.snarl.node_ids().count(), "rows": app.shown_rows() });
    STATE.with(|s| *s.borrow_mut() = state.to_string());
}
