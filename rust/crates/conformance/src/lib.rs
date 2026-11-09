//! The fixture harness, engine-independent: `transformers/<id>/tests.json` run on any
//! `SqlEngine` with the rules of `tests/harness/` (run-case.js, compare.js, wkt.js).
//! Used by the native tests and by the web build in the browser.

pub mod compare;
pub mod runner;
pub mod wkt;

/// Transformer folders covered by spike gate 1.
pub const GATE_1: &[&str] = &[
    "attribute-filter",
    "feature-joiner",
    "dissolver",
    "reprojector",
    "bufferer",
    "area-on-area-overlayer",
    "minimum-bounding-circle",
    "h3-geometry-from-index",
    "densify-features",
    "merge-line-segments",
    "simplify-features",
    "smooth-vectors",
    "vertex-creator",
    "h3-geometry-from-position",
    "polygon-to-h3",
    "positional-h3-index",
    "add-geometry-attributes",
    "bounding-box-replacer",
    "centroid-vector",
    "coordinate-system-setter",
    "eliminate-coincident-points",
    "filter-vector-features-by-area",
    "minimum-bounding-box",
    "minimum-convex-hull",
    "representative-point-vector",
    "duplicate-filter",
    "test-filter",
    "tester",
    "aggregator",
    "statistics-calculator",
    "attribute-correlation",
    "attribute-histogram",
    "list-unique-values",
    "unioner",
    "attribute-creator",
    "attribute-keeper",
    "attribute-manager",
    "attribute-remover",
    "attribute-renamer",
    "sql-transformer",
    "sorter",
    "sampler",
];

/// Run every case of `docs` ((folder, tests.json text)); returns (passed, failures).
pub async fn run_all(engine: &impl geomarmot_core::SqlEngine, docs: &[(String, String)]) -> (usize, Vec<String>) {
    let mut failures = Vec::new();
    let mut passed = 0;
    for (_, text) in docs {
        let doc: serde_json::Value = match serde_json::from_str(text) {
            Ok(d) => d,
            Err(e) => {
                failures.push(format!("unreadable fixture: {e}"));
                continue;
            }
        };
        let id = doc["transformer"].as_str().unwrap_or_default();
        for case in doc["cases"].as_array().into_iter().flatten() {
            let problems = runner::run_case(engine, id, case).await;
            runner::teardown(engine).await;
            if problems.is_empty() {
                passed += 1;
            } else {
                let name = case["name"].as_str().unwrap_or("?");
                failures.push(format!("{id} › {name}\n  {}", problems.join("\n  ")));
            }
        }
    }
    (passed, failures)
}
