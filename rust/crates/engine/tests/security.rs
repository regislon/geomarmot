//! Spike gate 6: the layer table of docs/rust-migration-plan.md (Security), row by row,
//! on the in-process engine and the engine process, with the guard bypassed (DuckDB's
//! locked configuration alone) and through the guard.

mod support;

use std::path::{Path, PathBuf};

use geomarmot_core::sqlguard::{Context, validate};
use geomarmot_engine::process::ProcessEngine;
use geomarmot_engine::{Config, Host, SqlEngine, io};
use support::runner::extension_dir;

struct Files {
    root: PathBuf,
}

impl Files {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("gm-security-{name}-{}", std::process::id()));
        io::clean_staging(&root).unwrap();
        std::fs::write(root.join("approved.csv"), "a\n1\n").unwrap();
        std::fs::write(root.join("neighbour.csv"), "a\n2\n").unwrap();
        let geojson = r#"{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"a":1},"geometry":{"type":"Point","coordinates":[1,2]}}]}"#;
        std::fs::write(root.join("approved.geojson"), geojson).unwrap();
        std::fs::write(root.join("neighbour.geojson"), geojson).unwrap();
        io::ensure_dir(&root.join("staging")).unwrap();
        Self { root }
    }
    fn p(&self, name: &str) -> String {
        self.root.join(name).to_string_lossy().into_owned()
    }
    fn config(&self) -> Config {
        Config {
            extension_dir: extension_dir(),
            allowed_paths: vec![self.p("approved.csv"), self.p("approved.geojson")],
            staging_dir: Some(self.root.join("staging")),
            memory_limit: Some("1GB".into()),
        }
    }
}

/// (row, SQL, DuckDB alone allows it?)
fn rows(f: &Files) -> Vec<(&'static str, String, bool)> {
    vec![
        (
            "read an approved CSV",
            format!("SELECT * FROM read_csv('{}')", f.p("approved.csv")),
            true,
        ),
        (
            "read an approved GeoJSON through GDAL",
            format!("SELECT * FROM ST_Read('{}')", f.p("approved.geojson")),
            true,
        ),
        (
            "read a file next to an approved one",
            format!("SELECT * FROM read_csv('{}')", f.p("neighbour.csv")),
            false,
        ),
        (
            "GDAL read of a file next to an approved one",
            format!("SELECT * FROM ST_Read('{}')", f.p("neighbour.geojson")),
            false,
        ),
        ("read /etc/hosts", "SELECT * FROM read_csv('/etc/hosts')".into(), false),
        (
            "read_text an unapproved file",
            format!("SELECT * FROM read_text('{}')", f.p("neighbour.csv")),
            false,
        ),
        (
            "glob the directory",
            format!("SELECT * FROM glob('{}/*')", f.root.display()),
            false,
        ),
        (
            "read an unapproved URL",
            "SELECT * FROM read_csv('https://example.com/x.csv')".into(),
            false,
        ),
        (
            "COPY outside staging",
            format!("COPY (SELECT 1 AS a) TO '{}'", f.p("out.csv")),
            false,
        ),
        (
            "COPY into staging",
            format!("COPY (SELECT 1 AS a) TO '{}'", f.p("staging/out.csv")),
            true,
        ),
        ("SET a setting", "SET memory_limit = '8GB'".into(), false),
        ("RESET the allow list", "RESET allowed_paths".into(), false),
        (
            "re-enable external access",
            "SET enable_external_access = true".into(),
            false,
        ),
        ("INSTALL an extension", "INSTALL h3 FROM community".into(), false),
        (
            "LOAD an extension by path",
            format!("LOAD '{}'", f.p("x.duckdb_extension")),
            false,
        ),
        ("LOAD an already-loaded bundled extension", "LOAD spatial".into(), true),
        (
            "ATTACH a database file",
            format!("ATTACH '{}' AS other", f.p("other.duckdb")),
            false,
        ),
    ]
}

async fn duckdb_layer(engine: &impl SqlEngine, f: &Files) -> Vec<String> {
    let mut wrong = Vec::new();
    for (row, sql, allowed) in rows(f) {
        let got = engine.exec(&sql).await;
        if got.is_ok() != allowed {
            wrong.push(format!(
                "{row}: expected {}, got {got:?}",
                if allowed { "allowed" } else { "blocked" }
            ));
        }
    }
    wrong
}

#[test]
fn duckdb_layer_in_process() {
    let f = Files::new("host");
    let host = Host::open(&f.config()).unwrap();
    let wrong = pollster::block_on(duckdb_layer(&host, &f));
    assert!(wrong.is_empty(), "\n{}", wrong.join("\n"));
}

#[test]
fn duckdb_layer_engine_process() {
    let f = Files::new("process");
    let binary = Path::new(env!("CARGO_BIN_EXE_geomarmot-engine"));
    let engine = ProcessEngine::spawn(binary, &f.config()).unwrap();
    let wrong = pollster::block_on(duckdb_layer(&engine, &f));
    assert!(wrong.is_empty(), "\n{}", wrong.join("\n"));
}

/// Restricted SQL: the guard refuses every row, including the ones DuckDB alone allows.
#[test]
fn guard_layer_refuses_every_row() {
    let f = Files::new("guard");
    let host = Host::open(&f.config()).unwrap();
    pollster::block_on(async {
        let mut accepted = Vec::new();
        for (row, sql, _) in rows(&f) {
            if validate(&host, &sql, Context::Query).await.is_ok() {
                accepted.push(row);
            }
        }
        // Reading an approved source is not done by fragments either: they read `input`.
        assert!(accepted.is_empty(), "guard accepted: {accepted:?}");
    });
}

#[test]
fn approvals_and_staged_exports() {
    let f = Files::new("io");
    let approvals = io::Approvals {
        sources: vec![f.p("approved.csv")],
        staging_dir: Some(f.root.join("staging")),
    };
    assert!(approvals.authorize(&f.p("approved.csv"), io::Access::Read).is_ok());
    assert!(approvals.authorize(&f.p("approved.csv"), io::Access::Write).is_err());
    assert!(approvals.authorize(&f.p("neighbour.csv"), io::Access::Read).is_err());
    assert!(
        approvals
            .authorize(&f.p("staging/../neighbour.csv"), io::Access::Read)
            .is_err()
    );
    let staged = f.root.join("staging/export.csv");
    std::fs::write(&staged, "a\n1\n").unwrap();
    let destination = f.root.join("final.csv");
    io::finalize_export(&approvals, &staged, &destination).unwrap();
    assert_eq!(std::fs::read_to_string(&destination).unwrap(), "a\n1\n");
    assert!(!staged.exists() && !f.root.join("final.csv.partial").exists());
}

/// No engine code touches the file system outside `io.rs` (the call-site test of the plan).
#[test]
fn file_access_only_in_io_module() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut offenders = Vec::new();
    for entry in walk(&src) {
        let text = std::fs::read_to_string(&entry).unwrap();
        let name = entry.file_name().unwrap().to_string_lossy().into_owned();
        if name != "io.rs" && (text.contains("std::fs") || text.contains("File::")) {
            offenders.push(entry.display().to_string());
        }
    }
    assert!(offenders.is_empty(), "file access outside io.rs: {offenders:?}");
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p))
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p)
        }
    }
    out
}
