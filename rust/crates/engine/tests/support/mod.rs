#![allow(dead_code)] // each test binary uses a different part of the support code

use std::path::{Path, PathBuf};

#[allow(unused_imports)]
pub use geomarmot_conformance::{compare, runner};

pub fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// Extensions installed once per checkout, as a build step would.
pub fn extension_dir() -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/duckdb-extensions");
    if !dir.exists() {
        geomarmot_engine::install_extensions(&dir).expect("install extensions");
    }
    dir
}

/// (folder, tests.json text) for every gate-1 folder.
pub fn fixture_docs() -> Vec<(String, String)> {
    geomarmot_conformance::GATE_1
        .iter()
        .map(|f| {
            (
                f.to_string(),
                std::fs::read_to_string(repo().join("transformers").join(f).join("tests.json")).unwrap(),
            )
        })
        .collect()
}
