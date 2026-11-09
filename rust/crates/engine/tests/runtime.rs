//! Spike gate 7: on each target, a locked engine boots from the bundled extensions only,
//! runs a spatial query and a Parquet read, and exits. CI runs it with the network off
//! where the runner allows; the locked configuration refuses any fetch on the others.

mod support;

use geomarmot_engine::{Config, Host, io, qlit};

#[test]
fn bundled_extensions_load_and_answer_offline() {
    let staging = std::env::temp_dir().join(format!("gm-runtime-{}", std::process::id()));
    io::clean_staging(&staging).unwrap();
    let host = Host::open(&Config {
        extension_dir: support::extension_dir(),
        staging_dir: Some(staging.clone()),
        ..Config::default()
    })
    .unwrap();
    let (version, platform) = geomarmot_engine::version_and_platform().unwrap();
    let area = host
        .query_now(
            "SELECT round(ST_Area(ST_Transform(ST_GeomFromText('POLYGON((7 46, 7.01 46, 7.01 46.01, 7 46.01, 7 46))'), \
             'EPSG:4326', 'EPSG:2056', always_xy := true))) AS m2",
        )
        .unwrap();
    let file = staging.join("t.parquet").to_string_lossy().into_owned();
    host.exec_now(&format!(
        "COPY (SELECT range AS i FROM range(1000)) TO {} (FORMAT PARQUET)",
        qlit(&file)
    ))
    .unwrap();
    let n = host
        .query_now(&format!("SELECT count(*) FROM read_parquet({})", qlit(&file)))
        .unwrap();
    let pretty = |b| {
        geomarmot_engine::arrow::util::pretty::pretty_format_batches(b)
            .unwrap()
            .to_string()
    };
    eprintln!(
        "runtime check: DuckDB {version} {platform}\n{}\n{}",
        pretty(&area),
        pretty(&n)
    );
    assert_eq!(n[0].num_rows(), 1);
}
