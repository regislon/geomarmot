//! The browser side of the engine boundary: `SqlEngine` over DuckDB-Wasm.
//!
//! DuckDB-Wasm runs in its own Web Worker; `web/bridge.js` exposes it as `globalThis.gmBridge`
//! (exec, query → Arrow IPC bytes, overlay → the GEOS worker pool). Results cross as Arrow IPC.

use geomarmot_sql::arrow::array::RecordBatch;
use geomarmot_sql::{KernelRequest, OverlayRequest, OverlayStats, RasterRequest, Result, SqlEngine, from_ipc, to_ipc};

pub mod raster;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = gmBridge, js_name = exec, catch)]
    async fn bridge_exec(sql: &str) -> std::result::Result<JsValue, JsValue>;
    #[wasm_bindgen(js_namespace = gmBridge, js_name = query, catch)]
    async fn bridge_query(sql: &str) -> std::result::Result<JsValue, JsValue>;
    #[wasm_bindgen(js_namespace = gmBridge, js_name = insertArrow, catch)]
    async fn bridge_insert_arrow(table: &str, ipc: &[u8]) -> std::result::Result<JsValue, JsValue>;
    #[wasm_bindgen(js_namespace = gmBridge, js_name = overlay, catch)]
    async fn bridge_overlay(request: &str) -> std::result::Result<JsValue, JsValue>;
}

/// The page-level calls the app makes besides SQL.
pub mod bridge {
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = gmBridge, js_name = addSource, catch)]
        async fn add_source_js(name: &str, bytes: &[u8], sql: &str) -> Result<JsValue, JsValue>;
        #[wasm_bindgen(js_namespace = gmBridge, js_name = cancel, catch)]
        async fn cancel_js() -> Result<JsValue, JsValue>;
        #[wasm_bindgen(js_namespace = gmBridge, js_name = path)]
        fn path_js(name: &str) -> String;
        #[wasm_bindgen(js_namespace = gmBridge, js_name = download, catch)]
        async fn download_js(copy: &str, name: &str) -> Result<JsValue, JsValue>;
    }

    /// Register a picked file and the view over it; replayed by the bridge after a restart.
    pub async fn add_source(name: &str, bytes: &[u8], sql: &str) -> Result<(), String> {
        add_source_js(name, bytes, sql)
            .await
            .map(|_| ())
            .map_err(super::message)
    }

    /// Cooperative cancel, then terminate and reboot the DuckDB worker (ADR 0004).
    pub async fn cancel() -> Result<String, String> {
        cancel_js()
            .await
            .map(|v| v.as_string().unwrap_or_default())
            .map_err(super::message)
    }

    /// Where the page keeps a file it registered under `name` (the locked engine's only directory).
    pub fn path(name: &str) -> String {
        path_js(name)
    }

    /// Run `copy` (a COPY … TO `path(name)`) and hand the file to the browser as a download.
    pub async fn download(copy: &str, name: &str) -> Result<(), String> {
        download_js(copy, name).await.map(|_| ()).map_err(super::message)
    }
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

    async fn insert_arrow(&self, table: &str, batches: &[RecordBatch]) -> Result<()> {
        bridge_insert_arrow(table, &to_ipc(batches)?)
            .await
            .map(|_| ())
            .map_err(message)
    }

    // ponytail: kernels run in the page's wasm, on the main thread; move them to a kernel worker
    // (docs/rust-migration-plan.md, Browser) before large H3 or per-feature work reaches the UI.
    async fn kernel(&self, request: &KernelRequest) -> Result<()> {
        geomarmot_kernels::features::drive(self, request).await
    }

    async fn raster(&self, request: &RasterRequest) -> Result<()> {
        raster::run(self, request).await
    }

    async fn overlay(&self, request: &OverlayRequest) -> Result<OverlayStats> {
        let stats = bridge_overlay(&request.encode()).await.map_err(message)?;
        OverlayStats::decode(&stats.as_string().unwrap_or_default())
    }
}

/// Spike gate 1 in the browser: run the fixtures (`[[folder, tests.json text], …]`) of the gate-1
/// folders on DuckDB-Wasm. Returns `{ passed, failures }` as JSON.
#[wasm_bindgen]
pub async fn run_fixtures(docs: String) -> String {
    let mut docs: Vec<(String, String)> = serde_json::from_str(&docs).unwrap_or_default();
    docs.retain(|(folder, _)| geomarmot_conformance::GATE_1.contains(&folder.as_str()));
    let (passed, failures) = geomarmot_conformance::run_all(&WasmEngine, &docs).await;
    serde_json::json!({ "passed": passed, "failures": failures }).to_string()
}

/// The SQL guard in the browser: "" when a restricted query fragment may run, else the refusal.
#[wasm_bindgen]
pub async fn validate_sql(sql: String) -> String {
    use geomarmot_core::sqlguard::{Context, validate};
    match validate(&WasmEngine, &sql, Context::Query).await {
        Ok(()) => String::new(),
        Err(r) => r.message,
    }
}
