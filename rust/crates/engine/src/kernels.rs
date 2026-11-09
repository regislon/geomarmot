//! Kernels run next to the data: read from DuckDB, compute in Rust, write back.

use std::sync::atomic::AtomicBool;

use geomarmot_kernels::overlay::{Kernel, Parts, overlay_faces};
use geomarmot_sql::arrow::array::{Array, AsArray, RecordBatch};
use geomarmot_sql::arrow::datatypes::{Float64Type, Int64Type};
use geomarmot_sql::{OverlayRequest, OverlayStats};

use crate::{Host, Result};

const CHUNK_BYTES: usize = 8 * 1024 * 1024;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn parts(batches: &[RecordBatch]) -> Parts {
    let mut p = Parts::default();
    for b in batches {
        let fid = b.column(0).as_primitive::<Int64Type>();
        let wkb = b.column(1).as_binary::<i32>();
        let f = |k: usize| b.column(k).as_primitive::<Float64Type>().clone();
        let (x0, y0, x1, y1) = (f(2), f(3), f(4), f(5));
        for i in 0..b.num_rows() {
            if wkb.is_null(i) {
                continue;
            }
            p.fid.push(fid.value(i));
            p.wkb.push(wkb.value(i).to_vec());
            p.bounds.push([x0.value(i), y0.value(i), x1.value(i), y1.value(i)]);
        }
    }
    p
}

/// Create `table` and fill it with `rows` (already SQL value lists), in statements of about CHUNK_BYTES.
// ponytail: hex WKB through INSERT, as the JavaScript engine does; switch to the Arrow appender if the
// checkpoint shows writing faces matters.
fn write(host: &Host, table: &str, columns: &str, rows: impl Iterator<Item = String>) -> Result<()> {
    host.exec_now(&format!("CREATE OR REPLACE TABLE {table} ({columns})"))?;
    let mut chunk = Vec::new();
    let mut bytes = 0;
    for row in rows {
        bytes += row.len();
        chunk.push(row);
        if bytes >= CHUNK_BYTES {
            host.exec_now(&format!("INSERT INTO {table} VALUES {}", chunk.join(", ")))?;
            chunk.clear();
            bytes = 0;
        }
    }
    if !chunk.is_empty() {
        host.exec_now(&format!("INSERT INTO {table} VALUES {}", chunk.join(", ")))?;
    }
    Ok(())
}

pub fn overlay(host: &Host, r: &OverlayRequest, cancel: &AtomicBool) -> Result<OverlayStats> {
    let read = format!(
        "SELECT fid::BIGINT, ST_AsWKB(part), ST_XMin(part), ST_YMin(part), ST_XMax(part), ST_YMax(part) \
         FROM (SELECT {fid} AS fid, UNNEST(ST_Dump({g})).geom AS part FROM {src} WHERE {g} IS NOT NULL) \
         WHERE ST_GeometryType(part) = 'POLYGON' AND NOT ST_IsEmpty(part) ORDER BY fid",
        fid = r.fid,
        g = r.geometry,
        src = r.source
    );
    let parts = parts(&host.query_now(&read)?);
    let faces = overlay_faces(&parts, Kernel::Geos, cancel)?;
    write(
        host,
        &r.faces,
        "face_id BIGINT, geometry GEOMETRY",
        faces
            .kept
            .iter()
            .enumerate()
            .map(|(i, f)| format!("({i}, ST_GeomFromHEXWKB('{}'))", hex(&f.wkb))),
    )?;
    write(
        host,
        &r.memberships,
        "face_id BIGINT, fid BIGINT",
        faces
            .kept
            .iter()
            .enumerate()
            .flat_map(|(i, f)| f.fids.iter().map(move |fid| format!("({i}, {fid})"))),
    )?;
    write(
        host,
        &r.ambiguous,
        "geometry GEOMETRY, area DOUBLE, clearance DOUBLE",
        faces
            .ambiguous
            .iter()
            .map(|a| format!("(ST_GeomFromHEXWKB('{}'), {}, {})", hex(&a.wkb), a.area, a.clearance)),
    )?;
    Ok(OverlayStats {
        faces: faces.kept.len(),
        ambiguous: faces.ambiguous.len(),
        parts: parts.wkb.len(),
        tasks: faces.tasks,
    })
}
