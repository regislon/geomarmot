//! The browser side of the engine boundary: `SqlEngine` over DuckDB-Wasm.
//!
//! DuckDB-Wasm runs in its own Web Worker; `web/bridge.js` exposes it as `globalThis.gmBridge`
//! (exec, query → Arrow IPC bytes, overlay → the GEOS worker pool). Results cross as Arrow IPC.

use geomarmot_sql::arrow::array::RecordBatch;
use geomarmot_sql::{OverlayRequest, OverlayStats, Result, SqlEngine, from_ipc};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = gmBridge, js_name = exec, catch)]
    async fn bridge_exec(sql: &str) -> std::result::Result<JsValue, JsValue>;
    #[wasm_bindgen(js_namespace = gmBridge, js_name = query, catch)]
    async fn bridge_query(sql: &str) -> std::result::Result<JsValue, JsValue>;
    #[wasm_bindgen(js_namespace = gmBridge, js_name = overlay, catch)]
    async fn bridge_overlay(request: &str) -> std::result::Result<JsValue, JsValue>;
}

fn message(e: JsValue) -> String {
    e.as_string()
        .or_else(|| {
            js_sys::Reflect::get(&e, &"message".into())
                .ok()
                .and_then(|m| m.as_string())
        })
        .unwrap_or_else(|| format!("{e:?}"))
}

/// The engine of the page: DuckDB-Wasm behind the bridge.
pub struct WasmEngine;

impl SqlEngine for WasmEngine {
    async fn exec(&self, sql: &str) -> Result<()> {
        bridge_exec(sql).await.map(|_| ()).map_err(message)
    }

    async fn query_arrow(&self, sql: &str) -> Result<Vec<RecordBatch>> {
        let bytes = bridge_query(sql).await.map_err(message)?;
        from_ipc(&js_sys::Uint8Array::new(&bytes).to_vec())
    }

    async fn overlay(&self, request: &OverlayRequest) -> Result<OverlayStats> {
        let stats = bridge_overlay(&request.encode()).await.map_err(message)?;
        OverlayStats::decode(&stats.as_string().unwrap_or_default())
    }
}

/// Spike gate 1 in the browser: run the fixtures (`[[folder, tests.json text], …]`) on DuckDB-Wasm.
/// Returns `{ passed, failures }` as JSON.
#[wasm_bindgen]
pub async fn run_fixtures(docs: String) -> String {
    let docs: Vec<(String, String)> = serde_json::from_str(&docs).unwrap_or_default();
    let (passed, failures) = geomarmot_conformance::run_all(&WasmEngine, &docs).await;
    serde_json::json!({ "passed": passed, "failures": failures }).to_string()
}
