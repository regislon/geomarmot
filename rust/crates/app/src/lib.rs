//! The GeoMarmot app (spike gate 5): canvas, inspector, table, map, open and export —
//! one codebase for the desktop (engine process) and the browser (DuckDB-Wasm).

pub mod app;
pub mod canvas;
pub mod form;
mod form_manager;
mod form_rows;
#[cfg(target_arch = "wasm32")]
pub mod hooks;
mod links;
pub mod map;
#[cfg(not(target_arch = "wasm32"))]
pub mod probe;
pub mod quickadd;
pub mod worker;

/// Browser entry: run the app on `canvas` once the page's bridge has booted DuckDB-Wasm.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub async fn start_app(canvas: web_sys::HtmlCanvasElement) -> Result<(), wasm_bindgen::JsValue> {
    eframe::WebRunner::new()
        .start(
            canvas,
            eframe::WebOptions::default(),
            Box::new(|cc| {
                let ctx = cc.egui_ctx.clone();
                let worker = worker::Worker::start(move || ctx.request_repaint());
                OPEN.with(|o| *o.borrow_mut() = Some(Box::new(worker.sender())));
                Ok(Box::new(app::App::new(worker)))
            }),
        )
        .await
}

#[cfg(target_arch = "wasm32")]
thread_local! {
    static OPEN: std::cell::RefCell<Option<Box<dyn Fn(worker::Job)>>> = const { std::cell::RefCell::new(None) };
}

/// Open a file from its bytes, as the Open button does after the browser's picker (tests, drag and drop).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn open_file_bytes(name: String, bytes: Vec<u8>) {
    OPEN.with(|o| {
        if let Some(send) = o.borrow().as_ref() {
            send(worker::Job::OpenBytes { name, bytes });
        }
    });
}
