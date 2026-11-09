//! Spike gate 3: terrio vs DuckDB's ST_Read on the same GeoPackages (same rows, columns,
//! types and geometry; time to a DuckDB table), Parquet over HTTP range reads from a local
//! server (bytes transferred), and a GeoPackage written by terrio and read back.

mod support;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use geomarmot_engine::{Config, Host, SqlEngine, io, qlit};
use support::extension_dir;

/// The GeoJSON of the JavaScript feature-panel fixture: a small polygon and a five-part,
/// 100,000-vertex boundary, each with 30 attributes (`tests/browser/geopackage.spec.js`).
fn areas_geojson() -> String {
    let ring = |cx: f64, n: usize| -> Vec<[f64; 2]> {
        (0..=n)
            .map(|k| {
                let a = std::f64::consts::TAU * (k % n) as f64 / n as f64;
                [cx + a.cos(), a.sin()]
            })
            .collect()
    };
    let props = |name: &str, last_null: bool| {
        let mut p = serde_json::Map::new();
        p.insert("name".into(), name.into());
        for k in 0..30 {
            let v = if last_null && k == 29 {
                serde_json::Value::Null
            } else {
                format!("v{k}").into()
            };
            p.insert(format!("attr_{k:02}"), v);
        }
        p
    };
    serde_json::json!({ "type": "FeatureCollection", "features": [
        { "type": "Feature", "properties": props("small", false),
          "geometry": { "type": "Polygon", "coordinates": [ring(0.0, 8)] } },
        { "type": "Feature", "properties": props("boundary", true),
          "geometry": { "type": "MultiPolygon",
                        "coordinates": (0..5).map(|p| vec![ring(p as f64 * 3.0, 20000)]).collect::<Vec<_>>() } },
    ]})
    .to_string()
}

/// GeoPackages written by GDAL (DuckDB's GDAL driver), as `tests/fixtures/build.js` writes them
/// with ogr2ogr: `feature-panel.gpkg` (areas, lon/lat) and `lv95.gpkg` (one point in EPSG:2056).
fn gdal_geopackages(dir: &std::path::Path) -> Vec<String> {
    let geojson = dir.join("areas.geojson");
    std::fs::write(&geojson, areas_geojson()).unwrap();
    let path = |name: &str| dir.join(name).to_string_lossy().into_owned();
    let host = Host::open(&Config {
        extension_dir: extension_dir(),
        allowed_paths: vec![
            geojson.to_string_lossy().into_owned(),
            path("feature-panel.gpkg"),
            path("lv95.gpkg"),
        ],
        staging_dir: Some(dir.to_path_buf()),
        memory_limit: None,
    })
    .unwrap();
    let copy = |select: &str, name: &str, layer: &str, srs: &str| {
        host.exec_now(&format!(
            "COPY ({select}) TO {} WITH (FORMAT GDAL, DRIVER 'GPKG', LAYER_NAME '{layer}', SRS '{srs}')",
            qlit(&path(name))
        ))
        .unwrap();
    };
    let source = geojson.to_string_lossy().into_owned();
    copy(
        &format!("SELECT * EXCLUDE (OGC_FID) FROM ST_Read({})", qlit(&source)),
        "feature-panel.gpkg",
        "areas",
        "EPSG:4326",
    );
    copy(
        "SELECT 'Bern' AS name, ST_Point(2600000, 1200000) AS geom",
        "lv95.gpkg",
        "sites",
        "EPSG:2056",
    );
    vec![path("feature-panel.gpkg"), path("lv95.gpkg")]
}

fn staging(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gm-readers-{name}-{}", std::process::id()));
    io::clean_staging(&dir).unwrap();
    dir
}

fn median(mut v: Vec<Duration>) -> Duration {
    v.sort();
    v[v.len() / 2]
}

fn one(host: &Host, sql: &str) -> serde_json::Value {
    pollster::block_on(host.query(sql)).unwrap().remove(0).remove(0)
}

/// terrio → Arrow → DuckDB (geometry as GEOMETRY), returning the table name.
fn via_terrio(host: &Host, path: &str, table: &str) -> Option<String> {
    let layers = geomarmot_io::read_vector(path).unwrap();
    let layer = &layers[0];
    host.create_from_arrow(&format!("{table}_raw"), &layer.schema, &layer.batches)
        .unwrap();
    host.exec_now(&format!(
        "CREATE OR REPLACE TABLE {table} AS SELECT * EXCLUDE (geometry), ST_GeomFromWKB(geometry) AS geom FROM {table}_raw"
    ))
    .unwrap();
    layer.crs.clone()
}

/// A GeoPackage of `n` generated polygons with a few attributes, written by terrio into `dir`.
fn big_geopackage(dir: &std::path::Path, n: usize) -> String {
    let host = Host::open(&Config {
        extension_dir: extension_dir(),
        ..Config::default()
    })
    .unwrap();
    let batches = host
        .query_now(&format!(
            "SELECT i::INTEGER AS id, 'name ' || i AS name, (i % 97)::DOUBLE AS score, \
             ST_AsWKB(ST_Buffer(ST_Point((i % 1000) * 0.01, (i // 1000) * 0.01), 0.004, 4)) AS geometry \
             FROM range({n}) t(i)"
        ))
        .unwrap();
    let path = dir.join("big.gpkg").to_string_lossy().into_owned();
    geomarmot_io::write_vector(&batches[0].schema(), &batches, "big", &path).unwrap();
    path
}

#[test]
fn terrio_and_st_read_agree_and_timings() {
    let dir = staging("gpkg");
    // Copies in the staging directory: GDAL (ST_Read, the comparison) probes sidecar files, which
    // only a directory permission allows. The app reads these formats with terrio instead.
    let mut files = gdal_geopackages(&dir);
    files.push(big_geopackage(&dir, 200_000));
    let config = Config {
        extension_dir: extension_dir(),
        allowed_paths: files.clone(),
        staging_dir: Some(dir),
        memory_limit: None,
    };
    let host = Host::open(&config).unwrap();
    for path in &files {
        let (mut t_terrio, mut t_gdal) = (vec![], vec![]);
        let mut crs = None;
        for _ in 0..5 {
            let t0 = Instant::now();
            crs = via_terrio(&host, path, "a");
            t_terrio.push(t0.elapsed());
            let t0 = Instant::now();
            host.exec_now(&format!(
                "CREATE OR REPLACE TABLE b AS SELECT * FROM ST_Read({0})",
                qlit(path)
            ))
            .unwrap();
            t_gdal.push(t0.elapsed());
        }
        let rows = one(&host, "SELECT count(*) FROM a");
        assert_eq!(rows, one(&host, "SELECT count(*) FROM b"), "{path}: row counts");
        let cols = |t: &str| {
            pollster::block_on(host.describe(t))
                .unwrap()
                .into_iter()
                .map(|c| format!("{} {}", c.name, c.kind))
                .collect::<Vec<_>>()
        };
        let geometry = |t: &str| one(&host, &format!("SELECT sum(hash(fid, ST_AsText(geom))) FROM {t}"));
        eprintln!(
            "{}: {rows} rows; terrio {:?}, ST_Read {:?} (median of 5); terrio CRS {crs:?}\n  terrio columns:  {:?}\n  ST_Read columns: {:?}",
            path.rsplit('/').next().unwrap(),
            median(t_terrio),
            median(t_gdal),
            cols("a"),
            cols("b"),
        );
        assert_eq!(geometry("a"), geometry("b"), "{path}: geometry differs");
    }
}

/// A one-file HTTP server that honours Range and counts the bytes it sends.
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

#[test]
fn parquet_range_reads_fetch_only_what_the_query_needs() {
    let dir = staging("parquet");
    let file = dir.join("wide.parquet");
    let writer = Host::open(&Config {
        extension_dir: extension_dir(),
        staging_dir: Some(dir.clone()),
        ..Config::default()
    })
    .unwrap();
    writer
        .exec_now(&format!(
            "COPY (SELECT i AS id, md5(i::VARCHAR) AS a, md5((i*7)::VARCHAR) AS b, random() AS c FROM range(2000000) t(i)) \
             TO {} (FORMAT PARQUET, ROW_GROUP_SIZE 100000)",
            qlit(&file.to_string_lossy())
        ))
        .unwrap();
    let mut bytes = Vec::new();
    std::fs::File::open(&file).unwrap().read_to_end(&mut bytes).unwrap();
    let size = bytes.len();
    let sent = Arc::new(AtomicUsize::new(0));
    let url = format!("http://127.0.0.1:{}/wide.parquet", serve(bytes, sent.clone()));
    let host = Host::open(&Config {
        extension_dir: extension_dir(),
        allowed_paths: vec![url.clone()],
        ..Config::default()
    })
    .unwrap();
    let n = one(&host, &format!("SELECT count(*) FROM read_parquet({})", qlit(&url)));
    let after_count = sent.load(Ordering::SeqCst);
    let first = one(
        &host,
        &format!("SELECT max(id) FROM read_parquet({}) WHERE id < 1000", qlit(&url)),
    );
    let after_filter = sent.load(Ordering::SeqCst) - after_count;
    eprintln!(
        "parquet over HTTP: file {size} bytes; count(*) fetched {after_count} bytes; one column with a filter fetched {after_filter} bytes ({n} rows, max {first})"
    );
    assert!(after_count < size / 10, "count(*) should read the footer, not the file");
    assert!(after_filter < size / 4, "one column of one row group, not the file");
}

#[test]
fn geopackage_written_by_terrio_reads_back() {
    let dir = staging("export");
    let source = gdal_geopackages(&dir).remove(0);
    let out = dir.join("out.gpkg").to_string_lossy().into_owned();
    let host = Host::open(&Config {
        extension_dir: extension_dir(),
        allowed_paths: vec![source.clone()],
        staging_dir: Some(dir.clone()),
        memory_limit: None,
    })
    .unwrap();
    via_terrio(&host, &source, "a");
    let batches = host
        .query_now("SELECT * EXCLUDE (geom), ST_AsWKB(geom) AS geometry FROM a")
        .unwrap();
    geomarmot_io::write_vector(&batches[0].schema(), &batches, "out", &out).unwrap();
    host.exec_now(&format!("CREATE TABLE back AS SELECT * FROM ST_Read({0})", qlit(&out)))
        .unwrap();
    let back = geomarmot_io::read_vector(&out).unwrap();
    let rows: usize = back[0].batches.iter().map(|b| b.num_rows()).sum();
    eprintln!(
        "GeoPackage round trip: {rows} rows read back by terrio, {} by ST_Read",
        one(&host, "SELECT count(*) FROM back")
    );
    assert_eq!(
        one(&host, "SELECT count(*) FROM a"),
        one(&host, "SELECT count(*) FROM back")
    );
    assert_eq!(
        one(&host, "SELECT sum(hash(ST_AsText(geom))) FROM a"),
        one(&host, "SELECT sum(hash(ST_AsText(geom))) FROM back"),
        "geometry survives the round trip"
    );
}
