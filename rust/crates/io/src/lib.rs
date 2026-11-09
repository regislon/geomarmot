//! Reading and writing files through terrio (pure Rust, no GDAL), as Arrow.
//!
//! The only crate that imports terrio (docs/rust-migration-plan.md). Geometry crosses as
//! WKB in a `geometry` column; the CRS travels beside the batches.

use geomarmot_sql::Result;
use geomarmot_sql::arrow::array::RecordBatch;
use geomarmot_sql::arrow::datatypes::SchemaRef;
use terrio::arrow::{ArrowWriteOptions, layer_from_arrow, layer_to_arrow};
use terrio::{VectorOpenOptions, VectorWriteOptions};

/// One layer of a vector file.
pub struct LayerData {
    pub name: String,
    /// The CRS as terrio reports it (an authority code when it has one), if any.
    pub crs: Option<String>,
    pub schema: SchemaRef,
    pub batches: Vec<RecordBatch>,
}

fn e(err: terrio::Error) -> String {
    err.to_string()
}

/// Every layer of a GeoPackage, GeoJSON, FlatGeobuf, … file, geometry as WKB.
pub fn read_vector(path: &str) -> Result<Vec<LayerData>> {
    let dataset = terrio::open_vector(path, &VectorOpenOptions::default()).map_err(e)?;
    dataset
        .layers
        .iter()
        .map(|layer| {
            // Keep the feature ids, as GDAL's readers do (GeoPackage `fid`).
            let options = ArrowWriteOptions {
                fid_column: Some("fid".into()),
                ..ArrowWriteOptions::default()
            };
            let table = layer_to_arrow(layer, &options).map_err(e)?;
            Ok(LayerData {
                name: layer.name.clone(),
                crs: layer
                    .crs
                    .as_ref()
                    .and_then(|c| c.epsg.map(|code| format!("EPSG:{code}"))),
                schema: table.schema,
                batches: table.batches,
            })
        })
        .collect()
}

/// Write one layer (geometry as WKB in `geometry`) to `path`; the format follows the extension.
pub fn write_vector(schema: &SchemaRef, batches: &[RecordBatch], name: &str, path: &str) -> Result<()> {
    let layer = layer_from_arrow(schema, batches, name).map_err(e)?;
    terrio::write_vector(&[layer], path, &VectorWriteOptions::default()).map_err(e)
}
