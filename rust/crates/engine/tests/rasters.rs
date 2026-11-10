//! Spike R1 (docs/ographis-port-plan.md): GeoTIFF/COG sources, the raster contract (a footprint
//! relation per raster port) and the first two raster transformers, in process and through the
//! engine process, across a restart. Rasters are generated here.

mod support;

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use geomarmot_core::{compile_node, transformers::by_id};
use geomarmot_engine::supervisor::{Reader, SourceRecord, SourceState, Supervisor};
use geomarmot_engine::{Config, Host, SqlEngine, io};
use geomarmot_io::raster::write_f32;
use serde_json::{Value, json};
use support::extension_dir;

const NODATA: f32 = -9999.0;
const T: [f64; 6] = [2_600_000.0, 10.0, 0.0, 1_200_000.0, 0.0, -10.0];
const LV95: &str = "EPSG:2056";

fn dir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("gm-rasters-{tag}-{}", std::process::id()));
    io::clean_staging(&d).unwrap();
    d
}

/// 600 × 500, value = row * 1000 + col.
fn gradient_cog(d: &Path) -> String {
    let path = d.join("gradient.tif").to_string_lossy().into_owned();
    let values = (0..500)
        .flat_map(|r| (0..600).map(move |c| (r * 1000 + c) as f32))
        .collect();
    write_f32(&path, values, (600, 500), T, Some(2056), NODATA, true).unwrap();
    path
}

/// 4 × 3 classes: 1 on the left, 2 on the right, one nodata pixel.
fn classes_tif(d: &Path) -> String {
    let path = d.join("classes.tif").to_string_lossy().into_owned();
    let values = vec![1.0, 1.0, 2.0, 2.0, 1.0, 1.0, 2.0, 2.0, 1.0, NODATA, 2.0, 2.0];
    write_f32(&path, values, (4, 3), T, Some(2056), NODATA, false).unwrap();
    path
}

const POINTS: &str = "CREATE OR REPLACE TABLE pts AS SELECT * FROM (VALUES
    ('a', ST_Point(2600035, 1199925)),
    ('b', ST_Point(2605995, 1195005)),
    ('outside', ST_Point(2500000, 1100000)),
    ('area', ST_MakeEnvelope(2600100, 1199800, 2600120, 1199820)),
    ('none', NULL::GEOMETRY)) t(name, geometry)";

async fn compile(engine: &impl SqlEngine, id: &str, params: Value, inputs: &[(&str, &str)], prefix: &str) -> String {
    let inputs: BTreeMap<String, (String, String)> = inputs
        .iter()
        .map(|(port, rel)| (port.to_string(), (rel.to_string(), LV95.to_string())))
        .collect();
    let out = compile_node(engine, by_id(id).unwrap(), &params, &inputs, prefix)
        .await
        .unwrap_or_else(|e| panic!("{id}: {e}"));
    out.views["output"].clone()
}

async fn sample_and_polygonize(engine: &impl SqlEngine, gradient: &str, classes: &str) {
    engine.exec(POINTS).await.unwrap();
    let footprint = engine
        .query(&format!(
            "SELECT width, height, bands, crs, data_type, ST_AsText(geometry) FROM {gradient}"
        ))
        .await
        .unwrap();
    assert_eq!(footprint[0][0], 600);
    assert_eq!(footprint[0][3], LV95);
    assert_eq!(footprint[0][4], "f32");
    assert!(
        footprint[0][5]
            .as_str()
            .unwrap()
            .starts_with("POLYGON ((2600000 1200000")
    );

    let view = compile(
        engine,
        "PointOnRasterValueExtractor",
        json!({ "band": "1", "attribute": "height" }),
        &[("input", "pts"), ("raster", gradient)],
        "n1",
    )
    .await;
    let rows = engine.query(&format!("SELECT name, height FROM {view}")).await.unwrap();
    let got: Vec<(String, Value)> = rows
        .into_iter()
        .map(|r| (r[0].as_str().unwrap().to_string(), r[1].clone()))
        .collect();
    // a: col 3, row 7 → 7003. b: col 599, row 499. area: centre (2600110, 1199810) → col 11, row 19.
    assert_eq!(
        got,
        vec![
            ("a".into(), json!(7003.0)),
            ("b".into(), json!(499_599.0)),
            ("outside".into(), Value::Null),
            ("area".into(), json!(19_011.0)),
            ("none".into(), Value::Null),
        ]
    );

    let areas = compile(
        engine,
        "RasterToPolygonCoercer",
        json!({ "band": "1" }),
        &[("input", classes)],
        "n2",
    )
    .await;
    let rows = engine
        .query(&format!(
            "SELECT value, round(ST_Area(geometry))::INT FROM {areas} ORDER BY value"
        ))
        .await
        .unwrap();
    assert_eq!(rows, vec![vec![json!(1.0), json!(500)], vec![json!(2.0), json!(600)]]);

    let wrong = compile_node(
        engine,
        by_id("RasterToPolygonCoercer").unwrap(),
        &json!({ "band": "3" }),
        &BTreeMap::from([("input".into(), (classes.to_string(), LV95.to_string()))]),
        "n3",
    )
    .await
    .err()
    .unwrap();
    assert!(wrong.contains("band 3 does not exist"), "{wrong}");
    let not_raster = compile_node(
        engine,
        by_id("RasterToPolygonCoercer").unwrap(),
        &json!({}),
        &BTreeMap::from([("input".into(), ("pts".to_string(), LV95.to_string()))]),
        "n4",
    )
    .await
    .err()
    .unwrap();
    assert!(not_raster.contains("connect a raster"), "{not_raster}");
}

#[test]
fn rasters_in_process() {
    let d = dir("host");
    let (gradient, classes) = (gradient_cog(&d), classes_tif(&d));
    let host = Host::open(&Config {
        extension_dir: extension_dir(),
        allowed_paths: vec![io::canonical(&gradient).unwrap(), io::canonical(&classes).unwrap()],
        ..Config::default()
    })
    .unwrap();
    assert_eq!(
        host.open_raster_now("g", &io::canonical(&gradient).unwrap())
            .unwrap()
            .as_deref(),
        Some(LV95)
    );
    host.open_raster_now("c", &io::canonical(&classes).unwrap()).unwrap();
    pollster::block_on(sample_and_polygonize(&host, "g", "c"));

    let other = d.join("other.tif").to_string_lossy().into_owned();
    write_f32(&other, vec![1.0], (1, 1), T, Some(2056), NODATA, false).unwrap();
    let refused = host.open_raster_now("o", &other).unwrap_err();
    assert!(refused.contains("was not approved"), "{refused}");
}

#[test]
fn rasters_through_the_engine_process_survive_a_restart() {
    let d = dir("process");
    let (gradient, classes) = (gradient_cog(&d), classes_tif(&d));
    let s = Supervisor::start(
        Path::new(env!("CARGO_BIN_EXE_geomarmot-engine")),
        Config {
            extension_dir: extension_dir(),
            staging_dir: Some(d.join("staging")),
            ..Config::default()
        },
        false,
    )
    .unwrap();
    for (name, path) in [("src_g", &gradient), ("src_c", &classes)] {
        let states = s
            .approve_source(SourceRecord {
                name: name.into(),
                location: path.clone(),
                reader: Reader::Raster,
                fingerprint: None,
            })
            .unwrap();
        assert!(states.iter().all(|(_, st)| *st == SourceState::Ready), "{states:?}");
    }
    let (_, engine) = s.engine();
    pollster::block_on(sample_and_polygonize(&*engine, "src_g", "src_c"));
    s.restart().unwrap();
    let (_, engine) = s.engine();
    pollster::block_on(sample_and_polygonize(&*engine, "src_g", "src_c"));
}

/// A raster above the global-operation budget: polygonize is refused from the header alone,
/// while sampling reads only the blocks under the points. Peak memory is printed for the report.
#[test]
fn a_raster_above_the_budget_is_sampled_by_block_and_refused_whole() {
    let d = dir("big");
    let path = d.join("big.tif").to_string_lossy().into_owned();
    let side = 8200; // 67.2 M cells > MAX_RASTER_CELLS (64 Mi)
    let t0 = std::time::Instant::now();
    let values: Vec<f32> = (0..side * side).map(|i| (i % 7) as f32).collect();
    write_f32(&path, values, (side, side), T, Some(2056), NODATA, true).unwrap();
    eprintln!("wrote a {side}×{side} COG in {:?}", t0.elapsed());
    let host = Host::open(&Config {
        extension_dir: extension_dir(),
        allowed_paths: vec![io::canonical(&path).unwrap()],
        ..Config::default()
    })
    .unwrap();
    host.open_raster_now("big", &io::canonical(&path).unwrap()).unwrap();
    let t0 = std::time::Instant::now();
    let refused = pollster::block_on(compile_node(
        &host,
        by_id("RasterToPolygonCoercer").unwrap(),
        &json!({}),
        &BTreeMap::from([("input".into(), ("big".to_string(), LV95.to_string()))]),
        "p",
    ))
    .err()
    .unwrap();
    assert!(refused.contains("67240000 cells"), "{refused}");
    eprintln!("polygonize refused in {:?}", t0.elapsed());

    host.exec_now(
        "CREATE TABLE many AS SELECT i AS id, ST_Point(2600000 + (i * 7919 % 82000), 1200000 - (i * 104729 % 82000)) AS geometry
           FROM range(20000) t(i)",
    )
    .unwrap();
    let t0 = std::time::Instant::now();
    let view = pollster::block_on(compile(
        &host,
        "PointOnRasterValueExtractor",
        json!({}),
        &[("input", "many"), ("raster", "big")],
        "s",
    ));
    let rows = host
        .query_now(&format!("SELECT count(raster_value) FROM {view}"))
        .unwrap();
    let sampled = geomarmot_engine::arrow::util::pretty::pretty_format_batches(&rows).unwrap();
    eprintln!("sampled 20000 points in {:?}\n{sampled}", t0.elapsed());
    assert!(sampled.to_string().contains("20000"));
}

/// Sampling alone on a big raster, for its peak memory (`/usr/bin/time -l`):
/// `GM_BIG_TIF=<path> cargo test --release -p geomarmot-engine --test rasters sampling_alone -- --ignored`.
#[test]
#[ignore = "needs GM_BIG_TIF, written by the test above"]
fn sampling_alone_on_a_big_raster() {
    let path = io::canonical(&std::env::var("GM_BIG_TIF").unwrap()).unwrap();
    let host = Host::open(&Config {
        extension_dir: extension_dir(),
        allowed_paths: vec![path.clone()],
        ..Config::default()
    })
    .unwrap();
    host.open_raster_now("big", &path).unwrap();
    host.exec_now(
        "CREATE TABLE many AS SELECT i AS id, ST_Point(2600000 + (i * 7919 % 82000), 1200000 - (i * 104729 % 82000)) AS geometry
           FROM range(20000) t(i)",
    )
    .unwrap();
    let view = pollster::block_on(compile(
        &host,
        "PointOnRasterValueExtractor",
        json!({}),
        &[("input", "many"), ("raster", "big")],
        "s",
    ));
    let n = pollster::block_on(host.query(&format!("SELECT count(raster_value)::INT FROM {view}"))).unwrap();
    assert_eq!(n[0][0], 20000);
}

/// A local server answering range requests, counting the bytes it sends (as `readers.rs`).
fn serve(bytes: Vec<u8>, sent: Arc<AtomicUsize>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let (mut head, mut range) = (String::new(), None);
            reader.read_line(&mut head).unwrap_or(0);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if let Some(r) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                    let (a, b) = r.trim().split_once('-').unwrap();
                    range = Some((
                        a.parse::<usize>().unwrap(),
                        b.parse::<usize>().unwrap_or(bytes.len() - 1),
                    ));
                }
            }
            let mut out = stream;
            let body: &[u8] = match range {
                Some((a, b)) => &bytes[a..=b.min(bytes.len() - 1)],
                None => &bytes,
            };
            let status = if range.is_some() {
                "206 Partial Content"
            } else {
                "200 OK"
            };
            let header = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
                body.len(),
                range.map_or(0, |r| r.0),
                range.map_or(bytes.len() - 1, |r| r.1.min(bytes.len() - 1)),
                bytes.len()
            );
            out.write_all(header.as_bytes()).ok();
            if !head.starts_with("HEAD") {
                out.write_all(body).ok();
                sent.fetch_add(body.len(), Ordering::SeqCst);
            }
        }
    });
    port
}

/// A COG over HTTP: opened from its URL (approved exactly), sampled by range requests that fetch
/// a small part of the file; an unapproved URL is refused before any request.
#[test]
fn a_cog_is_read_over_http_by_range_requests() {
    let d = dir("http");
    let path = d.join("big.tif").to_string_lossy().into_owned();
    let side = 4096;
    let values: Vec<f32> = (0..side * side).map(|i| (i % 1009) as f32).collect();
    write_f32(&path, values, (side, side), T, Some(2056), NODATA, true).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let size = bytes.len();
    let sent = Arc::new(AtomicUsize::new(0));
    let port = serve(bytes, sent.clone());
    let url = format!("http://127.0.0.1:{port}/big.tif");
    let host = Host::open(&Config {
        extension_dir: extension_dir(),
        allowed_paths: vec![url.clone()],
        ..Config::default()
    })
    .unwrap();
    let refused = host
        .open_raster_now("x", &format!("http://127.0.0.1:{port}/other.tif"))
        .unwrap_err();
    assert!(refused.contains("was not approved"));
    assert_eq!(sent.load(Ordering::SeqCst), 0, "nothing fetched for a refused URL");
    host.open_raster_now("web", &url).unwrap();
    host.exec_now(
        "CREATE TABLE few AS SELECT * FROM (VALUES (ST_Point(2600005, 1199995)), (ST_Point(2600015, 1199995))) t(geometry)",
    )
    .unwrap();
    let view = pollster::block_on(compile(
        &host,
        "PointOnRasterValueExtractor",
        json!({}),
        &[("input", "few"), ("raster", "web")],
        "w",
    ));
    let rows = pollster::block_on(host.query(&format!("SELECT raster_value FROM {view}"))).unwrap();
    assert_eq!(rows, vec![vec![json!(0.0)], vec![json!(1.0)]]);
    let fetched = sent.load(Ordering::SeqCst);
    eprintln!("COG over HTTP: {size} bytes, fetched {fetched} to open it and sample two points");
    assert!(fetched < size / 4, "fetched {fetched} of {size}");
}
