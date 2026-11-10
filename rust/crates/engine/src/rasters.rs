//! Rasters the engine owns (docs/ographis-port-plan.md, "The raster contract").
//!
//! An approved GeoTIFF/COG is opened lazily and kept in a registry under the id of its source;
//! its footprint row becomes a table of that name, so a raster port is an ordinary relation.
//! Raster kernels find the id through SQL (`SELECT raster FROM <input>`) and read pixels here.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use geomarmot_io::raster::{MAX_RASTER_CELLS, RasterInfo, open, polygonize, sample};
use geomarmot_sql::RasterRequest;
use geomarmot_sql::arrow::array::{Array, AsArray, Float64Array, Int64Array, RecordBatch};
use geomarmot_sql::arrow::compute::cast;
use geomarmot_sql::arrow::datatypes::{DataType, Field, Float64Type, Int64Type, Schema};

use crate::{Host, Result, io, qid};

/// Rasters by id: the lazy reader and what its footprint says.
pub(crate) type Registry = std::sync::Mutex<BTreeMap<String, (terrio::LazyRaster, RasterInfo)>>;

fn column<T: geomarmot_sql::arrow::datatypes::ArrowPrimitiveType>(
    b: &RecordBatch,
    i: usize,
    as_type: &DataType,
) -> Result<geomarmot_sql::arrow::array::PrimitiveArray<T>> {
    let c = cast(b.column(i), as_type).map_err(|e| e.to_string())?;
    Ok(c.as_primitive::<T>().clone())
}

impl Host {
    /// Open the approved raster at `path` as `name`: its footprint becomes table `name`, with
    /// the CRS as the table's comment.
    pub fn open_raster_now(&self, name: &str, path: &str) -> Result<Option<String>> {
        self.approvals.authorize(path, io::Access::Read)?;
        let (raster, info) = open(path)?;
        self.exec_now(&info.footprint_sql(name))?;
        let crs = info.crs.clone();
        self.rasters.lock().unwrap().insert(name.to_string(), (raster, info));
        Ok(crs)
    }

    /// Run a raster kernel; its result is table `request.output`.
    pub fn raster_now(&self, request: &RasterRequest) -> Result<()> {
        let ids: Vec<String> = self
            .query_now(&format!(
                "SELECT DISTINCT raster::VARCHAR FROM ({})",
                request.raster_sql
            ))?
            .iter()
            .flat_map(|b| {
                let a = b.column(0).as_string::<i32>().clone();
                (0..a.len())
                    .filter(|i| a.is_valid(*i))
                    .map(|i| a.value(i).to_string())
                    .collect::<Vec<_>>()
            })
            .collect();
        let id = match &ids[..] {
            [one] => one,
            [] => return Err("the raster input has no raster".into()),
            _ => {
                return Err(format!(
                    "the raster input has {} rasters; one is read at a time for now",
                    ids.len()
                ));
            }
        };
        let mut registry = self.rasters.lock().unwrap();
        let (raster, info) = registry
            .get_mut(id)
            .ok_or_else(|| format!("raster {id} is not open in this engine"))?;
        let cancel = self.cancel.clone();
        let cancelled = move || cancel.swap(false, Ordering::SeqCst);
        match request.op.as_str() {
            "sample" => {
                let mut points = Vec::new();
                for b in self.query_now(&request.input_sql)? {
                    let key = column::<Int64Type>(&b, 0, &DataType::Int64)?;
                    let x = column::<Float64Type>(&b, 1, &DataType::Float64)?;
                    let y = column::<Float64Type>(&b, 2, &DataType::Float64)?;
                    for i in 0..b.num_rows() {
                        if x.is_valid(i) && y.is_valid(i) {
                            points.push((key.value(i), x.value(i), y.value(i)));
                        }
                    }
                }
                let values = sample(raster, info, request.band, &points, &cancelled)?;
                let schema = Arc::new(Schema::new(vec![
                    Field::new("key", DataType::Int64, true),
                    Field::new("value", DataType::Float64, true),
                ]));
                let (keys, vals): (Vec<i64>, Vec<Option<f64>>) = values.into_iter().unzip();
                let batch = RecordBatch::try_new(
                    schema.clone(),
                    vec![Arc::new(Int64Array::from(keys)), Arc::new(Float64Array::from(vals))],
                )
                .map_err(|e| e.to_string())?;
                self.create_from_arrow(&request.output, &schema, &[batch])
            }
            "polygonize" => {
                let (schema, batches) = polygonize(raster, info, request.band, MAX_RASTER_CELLS)?;
                if cancelled() {
                    return Err("INTERRUPT Error: cancelled".into());
                }
                let raw = format!("{}__raw", request.output);
                self.create_from_arrow(&raw, &schema, &batches)?;
                self.exec_now(&format!(
                    "CREATE OR REPLACE TABLE {o} AS SELECT value, ST_GeomFromWKB(geometry) AS geometry FROM {r};
                     DROP TABLE {r};",
                    o = qid(&request.output),
                    r = qid(&raw)
                ))
            }
            other => Err(format!("unknown raster operation {other:?}")),
        }
    }
}
