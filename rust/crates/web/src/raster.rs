//! Rasters in the browser (docs/ographis-port-plan.md, spike R1): the same kernels as the desktop
//! engine (`geomarmot-raster`), run in the page's wasm. A dropped GeoTIFF is read from memory; a
//! COG from a URL through `terrio::sparse`: a read that misses bytes fails, the page fetches the
//! ranges it missed (`gmBridge.fetchRange`), and the read runs again.
//!
//! The footprint table is registered with `gmBridge.addSource`, so it is replayed into a fresh
//! DuckDB worker after a restart; the pixels stay here, outside DuckDB.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use geomarmot_raster::{MAX_RASTER_CELLS, RasterInfo, open_bytes, open_sparse, polygonize, sample};
use geomarmot_sql::arrow::array::{Array, AsArray, Float64Array, Int64Array, RecordBatch};
use geomarmot_sql::arrow::compute::cast;
use geomarmot_sql::arrow::datatypes::{DataType, Field, Float64Type, Int64Type, Schema};
use geomarmot_sql::{RasterRequest, Result, SqlEngine, qid};
use terrio::LazyRaster;
use terrio::sparse::SparseFile;
use wasm_bindgen::prelude::*;

use crate::{WasmEngine, bridge, message};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = gmBridge, js_name = fetchLength, catch)]
    async fn fetch_length(url: &str) -> std::result::Result<JsValue, JsValue>;
    #[wasm_bindgen(js_namespace = gmBridge, js_name = fetchRange, catch)]
    async fn fetch_range(url: &str, offset: f64, length: f64) -> std::result::Result<JsValue, JsValue>;
}

struct Entry {
    raster: LazyRaster,
    info: RasterInfo,
    /// For a URL: the bytes fetched so far, and where the rest is.
    remote: Option<(SparseFile, String)>,
}

thread_local! {
    static RASTERS: RefCell<HashMap<String, Entry>> = RefCell::new(HashMap::new());
}

/// Fetch every range `file` missed. Returns how many bytes were fetched.
async fn fill(file: &SparseFile, url: &str) -> Result<u64> {
    let mut fetched = 0;
    for (offset, length) in file.missing() {
        let bytes = fetch_range(url, offset as f64, length as f64).await.map_err(message)?;
        let bytes = js_sys::Uint8Array::new(&bytes).to_vec();
        fetched += bytes.len() as u64;
        file.insert(offset, &bytes);
    }
    Ok(fetched)
}

/// Run `read` until it no longer misses bytes of a remote raster.
async fn with_bytes<T>(remote: Option<&(SparseFile, String)>, mut read: impl FnMut() -> Result<T>) -> Result<T> {
    loop {
        let result = read();
        match remote {
            Some((file, url)) if file.has_missing() => {
                if fill(file, url).await? == 0 {
                    return result;
                }
            }
            _ => return result,
        }
    }
}

async fn register(name: &str, entry: Entry) -> Result<Option<String>> {
    bridge::add_source(&format!("{name}.raster"), &[], &entry.info.footprint_sql(name)).await?;
    let crs = entry.info.crs.clone();
    RASTERS.with(|r| r.borrow_mut().insert(name.to_string(), entry));
    Ok(crs)
}

/// A GeoTIFF the user dropped or picked, as `name`. Returns its CRS.
pub async fn open_file(name: &str, label: &str, bytes: Vec<u8>) -> Result<Option<String>> {
    let (raster, info) = open_bytes(bytes, label)?;
    register(
        name,
        Entry {
            raster,
            info,
            remote: None,
        },
    )
    .await
}

/// A COG at `url` (typed by the user), read by range requests, as `name`. Returns its CRS.
pub async fn open_url(name: &str, url: &str) -> Result<Option<String>> {
    let length = fetch_length(url)
        .await
        .map_err(message)?
        .as_f64()
        .ok_or("the server did not say how large the file is")?;
    let file = SparseFile::new(length as u64);
    let remote = (file.clone(), url.to_string());
    let (raster, info) = with_bytes(Some(&remote), || open_sparse(file.clone(), url)).await?;
    register(
        name,
        Entry {
            raster,
            info,
            remote: Some(remote),
        },
    )
    .await
}

fn column<T: geomarmot_sql::arrow::datatypes::ArrowPrimitiveType>(
    b: &RecordBatch,
    i: usize,
    as_type: &DataType,
) -> Result<geomarmot_sql::arrow::array::PrimitiveArray<T>> {
    let c = cast(b.column(i), as_type).map_err(|e| e.to_string())?;
    Ok(c.as_primitive::<T>().clone())
}

/// A raster kernel, as the desktop engine runs it (`crates/engine/src/rasters.rs`).
pub async fn run(engine: &WasmEngine, request: &RasterRequest) -> Result<()> {
    let ids: Vec<String> = engine
        .query(&format!(
            "SELECT DISTINCT raster::VARCHAR FROM ({})",
            request.raster_sql
        ))
        .await?
        .into_iter()
        .filter_map(|r| r.first()?.as_str().map(String::from))
        .collect();
    let id = match &ids[..] {
        [one] => one.clone(),
        [] => return Err("the raster input has no raster".into()),
        _ => {
            return Err(format!(
                "the raster input has {} rasters; one is read at a time for now",
                ids.len()
            ));
        }
    };
    // Taken out while it works (the work awaits fetches), put back after.
    let mut entry = RASTERS
        .with(|r| r.borrow_mut().remove(&id))
        .ok_or_else(|| format!("raster {id} is not open on this page"))?;
    let result = kernel(engine, request, &mut entry).await;
    RASTERS.with(|r| r.borrow_mut().insert(id, entry));
    result
}

async fn kernel(engine: &WasmEngine, request: &RasterRequest, e: &mut Entry) -> Result<()> {
    let Entry { raster, info, remote } = e;
    match request.op.as_str() {
        "sample" => {
            let mut points = Vec::new();
            for b in engine.query_arrow(&request.input_sql).await? {
                let key = column::<Int64Type>(&b, 0, &DataType::Int64)?;
                let x = column::<Float64Type>(&b, 1, &DataType::Float64)?;
                let y = column::<Float64Type>(&b, 2, &DataType::Float64)?;
                for i in 0..b.num_rows() {
                    if x.is_valid(i) && y.is_valid(i) {
                        points.push((key.value(i), x.value(i), y.value(i)));
                    }
                }
            }
            let values = with_bytes(remote.as_ref(), || {
                sample(raster, info, request.band, &points, &|| false)
            })
            .await?;
            let schema = Arc::new(Schema::new(vec![
                Field::new("key", DataType::Int64, true),
                Field::new("value", DataType::Float64, true),
            ]));
            let (keys, vals): (Vec<i64>, Vec<Option<f64>>) = values.into_iter().unzip();
            let batch = RecordBatch::try_new(
                schema,
                vec![Arc::new(Int64Array::from(keys)), Arc::new(Float64Array::from(vals))],
            )
            .map_err(|e| e.to_string())?;
            engine.insert_arrow(&request.output, &[batch]).await
        }
        "polygonize" => {
            let (_, batches) = with_bytes(remote.as_ref(), || {
                polygonize(raster, info, request.band, MAX_RASTER_CELLS)
            })
            .await?;
            let raw = format!("{}__raw", request.output);
            engine.insert_arrow(&raw, &batches).await?;
            engine
                .exec(&format!(
                    "CREATE OR REPLACE TABLE {o} AS SELECT value, ST_GeomFromWKB(geometry) AS geometry FROM {r};
                     DROP TABLE {r};",
                    o = qid(&request.output),
                    r = qid(&raw)
                ))
                .await
        }
        other => Err(format!("unknown raster operation {other:?}")),
    }
}
