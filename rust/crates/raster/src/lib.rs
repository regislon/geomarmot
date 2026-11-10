//! Rasters (GeoTIFF, Cloud Optimized GeoTIFF) through terrio, pure Rust
//! (docs/ographis-port-plan.md, "The raster contract").
//!
//! A raster is opened lazily: only its header is read. Pixels are read by block for point-local
//! work (sampling) and whole, under a cell limit, for global work (polygonize).

use std::collections::BTreeMap;
use std::sync::Arc;

use geomarmot_sql::arrow::array::{ArrayRef, BinaryArray, Float64Array, RecordBatch};
use geomarmot_sql::arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use geomarmot_sql::{Result, qid, qlit};
use terrio::ops::polygonize::{PolygonizeOptions, polygonize as terrio_polygonize};
use terrio::{FieldValue, Geometry};
use terrio::{LazyRaster, Window, WindowOptions};

/// Cells a global operation may hold in memory (one band).
pub const MAX_RASTER_CELLS: usize = 64 * 1024 * 1024;
/// Features polygonize may produce.
pub const MAX_POLYGONIZE_FEATURES: usize = 2_000_000;
/// Points one sampling may take.
pub const MAX_SAMPLE_POINTS: usize = 5_000_000;

fn e(err: terrio::Error) -> String {
    err.to_string()
}

/// What the footprint row of a raster says about it.
#[derive(Debug, Clone, PartialEq)]
pub struct RasterInfo {
    pub width: usize,
    pub height: usize,
    pub bands: usize,
    pub data_type: String,
    pub nodata: Option<f64>,
    pub crs: Option<String>,
    /// GDAL order: x0, pixel width, row rotation, y0, column rotation, pixel height (negative).
    pub transform: [f64; 6],
    /// The block (tile or strip) size, which sampling reads one at a time.
    pub block: (usize, usize),
}

/// The companion files terrio reads beside a local GeoTIFF (GDAL's: overviews, PAM metadata,
/// mask). Approving a raster approves exactly these names too.
pub fn companions(path: &str) -> Vec<String> {
    if path.contains("://") {
        return vec![];
    }
    [".ovr", ".aux.xml", ".msk"]
        .iter()
        .map(|s| format!("{path}{s}"))
        .collect()
}

/// Open the GeoTIFF or COG at `path` (a file or an `http(s)://` URL read by range requests)
/// lazily: headers only. Read as a TIFF whatever its name, so it can never point to other files
/// (VRT, STAC); see `companions` for what is read beside it.
#[cfg(not(target_arch = "wasm32"))]
pub fn open(path: &str) -> Result<(LazyRaster, RasterInfo)> {
    let raster = LazyRaster::open_tiff(path)
        .map_err(e)?
        .ok_or_else(|| format!("{path} is not a GeoTIFF"))?;
    let info = describe(&raster, path)?;
    Ok((raster, info))
}

/// A GeoTIFF held in memory (a file dropped on the page).
pub fn open_bytes(bytes: Vec<u8>, name: &str) -> Result<(LazyRaster, RasterInfo)> {
    let raster = LazyRaster::from_tiff_bytes(bytes)
        .map_err(e)?
        .ok_or_else(|| format!("{name} is not a GeoTIFF"))?;
    let info = describe(&raster, name)?;
    Ok((raster, info))
}

/// A remote GeoTIFF whose bytes the caller fetches (`terrio::sparse`): fails while bytes are
/// missing; the caller fetches `file.missing()` and calls again.
pub fn open_sparse(file: terrio::sparse::SparseFile, name: &str) -> Result<(LazyRaster, RasterInfo)> {
    let raster = LazyRaster::from_sparse(file)
        .map_err(e)?
        .ok_or_else(|| format!("{name} is not a GeoTIFF"))?;
    let info = describe(&raster, name)?;
    Ok((raster, info))
}

/// What the footprint row says about an opened raster.
pub fn describe(raster: &LazyRaster, name: &str) -> Result<RasterInfo> {
    if !raster.has_geo_transform() {
        return Err(format!("{name} has no georeferencing"));
    }
    let crs = raster.crs();
    Ok(RasterInfo {
        width: raster.width(),
        height: raster.height(),
        bands: raster.band_count(),
        data_type: format!("{:?}", raster.data_type()).to_lowercase(),
        nodata: raster.band_nodata(1),
        crs: crs.epsg.map(|c| format!("EPSG:{c}")).or_else(|| crs.authority_code()),
        transform: raster.geo_transform(),
        block: raster
            .block_size()
            .unwrap_or((raster.width(), 256.min(raster.height()).max(1))),
    })
}

impl RasterInfo {
    /// The world coordinates of pixel corner (col, row).
    pub fn world(&self, col: f64, row: f64) -> (f64, f64) {
        let t = &self.transform;
        (t[0] + col * t[1] + row * t[2], t[3] + col * t[4] + row * t[5])
    }

    /// The pixel (col, row) holding world point (x, y), if it is inside the raster.
    pub fn pixel(&self, x: f64, y: f64) -> Option<(usize, usize)> {
        let t = &self.transform;
        let det = t[1] * t[5] - t[2] * t[4];
        if det == 0.0 || !x.is_finite() || !y.is_finite() {
            return None;
        }
        let (dx, dy) = (x - t[0], y - t[3]);
        let col = (t[5] * dx - t[2] * dy) / det;
        let row = (t[1] * dy - t[4] * dx) / det;
        let inside = col >= 0.0 && row >= 0.0 && col < self.width as f64 && row < self.height as f64;
        inside.then(|| (col.floor() as usize, row.floor() as usize))
    }

    /// SQL creating table `id`: the footprint row of the raster, with its CRS as the table's
    /// comment. Plain SQL, so the browser can replay it into a fresh engine.
    pub fn footprint_sql(&self, id: &str) -> String {
        let num = |v: f64| if v.is_finite() { format!("{v:?}") } else { "NULL".into() };
        let (w, h) = (self.width as f64, self.height as f64);
        let ring: Vec<String> = [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h), (0.0, 0.0)]
            .iter()
            .map(|(c, r)| {
                let (x, y) = self.world(*c, *r);
                format!("{} {}", num(x), num(y))
            })
            .collect();
        let transform: Vec<String> = self.transform.iter().map(|v| num(*v)).collect();
        format!(
            "CREATE OR REPLACE TABLE {t} AS SELECT {id}::VARCHAR AS raster, {w}::BIGINT AS width, {h}::BIGINT AS height,
               {b}::BIGINT AS bands, {dt}::VARCHAR AS data_type, {nd}::DOUBLE AS nodata, {crs}::VARCHAR AS crs,
               [{tr}]::DOUBLE[6] AS transform, {px}::DOUBLE AS pixel_x, {py}::DOUBLE AS pixel_y,
               ST_GeomFromText({poly}) AS geometry;
             COMMENT ON TABLE {t} IS {comment};",
            t = qid(id),
            id = qlit(id),
            w = self.width,
            h = self.height,
            b = self.bands,
            dt = qlit(&self.data_type),
            nd = self.nodata.map_or("NULL".into(), num),
            crs = self.crs.as_deref().map_or("NULL".into(), qlit),
            tr = transform.join(", "),
            px = num(self.transform[1].abs()),
            py = num(self.transform[5].abs()),
            poly = qlit(&format!("POLYGON(({}))", ring.join(", "))),
            comment = qlit(self.crs.as_deref().unwrap_or_default()),
        )
    }
}

fn check_band(info: &RasterInfo, band: usize) -> Result<()> {
    if band == 0 || band > info.bands {
        return Err(format!("band {band} does not exist (the raster has {})", info.bands));
    }
    Ok(())
}

/// A point to sample: its index, column and row.
type Wanted = (usize, usize, usize);

fn is_nodata(v: f64, nodata: Option<f64>) -> bool {
    v.is_nan() || nodata.is_some_and(|n| v == n || (n.is_nan() && v.is_nan()))
}

/// The value of `band` under each point `(key, x, y)` (x, y in the raster's CRS); None outside the
/// raster or on nodata. Reads one block at a time; `cancelled` is checked between blocks.
pub fn sample(
    raster: &mut LazyRaster,
    info: &RasterInfo,
    band: usize,
    points: &[(i64, f64, f64)],
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<(i64, Option<f64>)>> {
    check_band(info, band)?;
    if points.len() > MAX_SAMPLE_POINTS {
        return Err(format!(
            "{} points to sample; at most {MAX_SAMPLE_POINTS} are read at once",
            points.len()
        ));
    }
    let (bw, bh) = (info.block.0.max(1), info.block.1.max(1));
    let mut by_block: BTreeMap<(usize, usize), Vec<Wanted>> = BTreeMap::new();
    let mut values = vec![None; points.len()];
    for (i, (_, x, y)) in points.iter().enumerate() {
        if let Some((col, row)) = info.pixel(*x, *y) {
            by_block.entry((col / bw, row / bh)).or_default().push((i, col, row));
        }
    }
    let options = WindowOptions {
        bands: vec![band],
        overview: None,
    };
    for ((bx, by), wanted) in by_block {
        if cancelled() {
            return Err("INTERRUPT Error: cancelled".into());
        }
        let (x0, y0) = (bx * bw, by * bh);
        let window = Window::new(x0, y0, bw.min(info.width - x0), bh.min(info.height - y0));
        let block = raster.read_window(window, &options).map_err(e)?;
        let nodata = block.band_nodata(1).or(info.nodata);
        for (i, col, row) in wanted {
            let v = block.raster.get_raw(0, (row - y0) as isize, (col - x0) as isize);
            values[i] = v.filter(|v| !is_nodata(*v, nodata));
        }
    }
    Ok(points.iter().zip(values).map(|((k, _, _), v)| (*k, v)).collect())
}

/// The areas of equal value of `band` as polygons (`value` DOUBLE, `geometry` WKB), nodata left
/// out. Global: the band is read whole, so it is refused above `MAX_RASTER_CELLS`.
/// `max_cells` is `MAX_RASTER_CELLS` outside tests.
pub fn polygonize(
    raster: &mut LazyRaster,
    info: &RasterInfo,
    band: usize,
    max_cells: usize,
) -> Result<(SchemaRef, Vec<RecordBatch>)> {
    check_band(info, band)?;
    let cells = info.width.saturating_mul(info.height);
    if cells > max_cells {
        return Err(format!(
            "the raster has {cells} cells; polygonizing reads at most {max_cells} (clip or resample it first)"
        ));
    }
    let options = WindowOptions {
        bands: vec![band],
        overview: None,
    };
    let data = raster
        .read_window(Window::full(info.width, info.height), &options)
        .map_err(e)?;
    let layer = terrio_polygonize(
        &data,
        &PolygonizeOptions {
            band: 0,
            field_name: "value".into(),
            ..PolygonizeOptions::default()
        },
    )
    .map_err(e)?;
    if layer.features.len() > MAX_POLYGONIZE_FEATURES {
        return Err(format!(
            "polygonizing makes {} areas; at most {MAX_POLYGONIZE_FEATURES} are kept (generalize the raster first)",
            layer.features.len()
        ));
    }
    let mut values = Vec::with_capacity(layer.features.len());
    let mut shapes = Vec::with_capacity(layer.features.len());
    for f in &layer.features {
        let value = match f.attributes.first() {
            Some(FieldValue::Float(v)) => Some(*v),
            Some(FieldValue::Integer(v)) => Some(*v as f64),
            _ => None,
        };
        values.push(value);
        shapes.push(f.geometry.as_ref().and_then(wkb));
    }
    let schema = Arc::new(Schema::new(vec![
        Field::new("value", DataType::Float64, true),
        Field::new("geometry", DataType::Binary, true),
    ]));
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(Float64Array::from(values)) as ArrayRef,
            Arc::new(BinaryArray::from_iter(shapes)),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok((schema, vec![batch]))
}

/// ISO WKB (2D) of the polygons polygonize makes; None for other shapes.
fn wkb(g: &Geometry) -> Option<Vec<u8>> {
    type Rings = Vec<Vec<(f64, f64)>>;
    fn polygon(out: &mut Vec<u8>, rings: Rings) {
        out.push(1);
        out.extend(3u32.to_le_bytes());
        out.extend((rings.len() as u32).to_le_bytes());
        for ring in rings {
            out.extend((ring.len() as u32).to_le_bytes());
            for (x, y) in ring {
                out.extend(x.to_le_bytes());
                out.extend(y.to_le_bytes());
            }
        }
    }
    let mut out = Vec::new();
    match g {
        Geometry::Polygon { exterior, interiors } => {
            let rings: Rings = std::iter::once(exterior)
                .chain(interiors)
                .map(|r| r.0.iter().map(|c| (c.x, c.y)).collect())
                .collect();
            polygon(&mut out, rings);
        }
        Geometry::MultiPolygon(parts) => {
            out.push(1);
            out.extend(6u32.to_le_bytes());
            out.extend((parts.len() as u32).to_le_bytes());
            for (exterior, interiors) in parts {
                let rings: Rings = std::iter::once(exterior)
                    .chain(interiors)
                    .map(|r| r.0.iter().map(|c| (c.x, c.y)).collect())
                    .collect();
                polygon(&mut out, rings);
            }
        }
        _ => return None,
    }
    Some(out)
}

/// Write one f32 band of `width` × `height` values (row by row from the top) as a GeoTIFF, or a
/// Cloud Optimized GeoTIFF (tiled, with overviews) when `cog`. North-up transforms only.
#[cfg(not(target_arch = "wasm32"))]
pub fn write_f32(
    path: &str,
    values: Vec<f32>,
    (width, height): (usize, usize),
    transform: [f64; 6],
    epsg: Option<u32>,
    nodata: f32,
    cog: bool,
) -> Result<()> {
    if transform[2] != 0.0 || transform[4] != 0.0 || transform[5] >= 0.0 {
        return Err("only north-up rasters are written".into());
    }
    let config = terrio::RasterConfig {
        cols: width,
        rows: height,
        bands: 1,
        x_min: transform[0],
        y_min: transform[3] + height as f64 * transform[5],
        cell_size: transform[1],
        cell_size_y: Some(-transform[5]),
        nodata: nodata as f64,
        data_type: terrio::DataType::F32,
        crs: wbraster_crs(epsg),
        metadata: vec![],
    };
    let raster = terrio::raster_from_data(config, terrio::raster::RasterData::F32(values)).map_err(e)?;
    let options = terrio::RasterWriteOptions {
        driver: Some(if cog {
            terrio::formats::RasterDriver::Cog
        } else {
            terrio::formats::RasterDriver::GTiff
        }),
        tile_size: Some(256),
        ..Default::default()
    };
    terrio::write_raster(&raster, path, &options).map_err(e)
}

#[cfg(not(target_arch = "wasm32"))]
fn wbraster_crs(epsg: Option<u32>) -> terrio::raster::CrsInfo {
    terrio::raster::CrsInfo {
        epsg,
        ..Default::default()
    }
}
