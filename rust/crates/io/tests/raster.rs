//! GeoTIFF and Cloud Optimized GeoTIFF through terrio: rasters are generated here, never
//! committed (AGENTS.md).

use geomarmot_io::raster::{MAX_RASTER_CELLS, open, polygonize, sample, write_f32};
use geomarmot_sql::arrow::array::AsArray;
use geomarmot_sql::arrow::datatypes::Float64Type;

const NODATA: f32 = -9999.0;
/// 10 m pixels, upper left corner at (2600000, 1200000), Swiss LV95.
const T: [f64; 6] = [2_600_000.0, 10.0, 0.0, 1_200_000.0, 0.0, -10.0];

fn dir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("gm-raster-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// value = row * 1000 + col, nodata on the diagonal.
fn gradient(width: usize, height: usize) -> Vec<f32> {
    (0..height)
        .flat_map(|r| (0..width).map(move |c| if r == c { NODATA } else { (r * 1000 + c) as f32 }))
        .collect()
}

#[test]
fn a_cog_opens_lazily_with_its_georeferencing() {
    let d = dir("open");
    let path = d.join("g.tif").to_string_lossy().into_owned();
    write_f32(&path, gradient(600, 500), (600, 500), T, Some(2056), NODATA, true).unwrap();
    let (_, info) = open(&path).unwrap();
    assert_eq!((info.width, info.height, info.bands), (600, 500, 1));
    assert_eq!(info.crs.as_deref(), Some("EPSG:2056"));
    assert_eq!(info.transform, T);
    assert_eq!(info.nodata, Some(NODATA as f64));
    assert_eq!(info.data_type, "f32");
    assert_eq!(info.block, (256, 256), "a COG is tiled");
    let sql = info.footprint_sql("r1");
    assert!(
        sql.contains("'r1'::VARCHAR AS raster") && sql.contains("600::BIGINT AS width"),
        "{sql}"
    );
    assert!(sql.contains("COMMENT ON TABLE \"r1\" IS 'EPSG:2056'"), "{sql}");
    assert_eq!(info.world(600.0, 500.0), (2_606_000.0, 1_195_000.0));
}

#[test]
fn sampling_reads_the_pixel_under_each_point() {
    let d = dir("sample");
    for (name, cog) in [("plain.tif", false), ("cog.tif", true)] {
        let path = d.join(name).to_string_lossy().into_owned();
        write_f32(&path, gradient(600, 500), (600, 500), T, Some(2056), NODATA, cog).unwrap();
        let (mut raster, info) = open(&path).unwrap();
        // Pixel centre (col, row) is at x0 + 10 col + 5, y0 - 10 row - 5.
        let at = |c: f64, r: f64| (2_600_000.0 + 10.0 * c + 5.0, 1_200_000.0 - 10.0 * r - 5.0);
        let points: Vec<(i64, f64, f64)> = [(0.0, 0.0), (3.0, 7.0), (599.0, 499.0), (300.0, 260.0), (10.0, 10.0)]
            .iter()
            .enumerate()
            .map(|(k, (c, r))| {
                let (x, y) = at(*c, *r);
                (k as i64, x, y)
            })
            .chain([(9, 2_599_990.0, 1_199_995.0)])
            .collect();
        let got = sample(&mut raster, &info, 1, &points, &|| false).unwrap();
        let values: Vec<Option<f64>> = got.iter().map(|(_, v)| *v).collect();
        assert_eq!(
            values,
            vec![None, Some(7003.0), Some(499_599.0), Some(260_300.0), None, None],
            "{name}: nodata on the diagonal, nothing outside"
        );
        assert_eq!(got.iter().map(|(k, _)| *k).collect::<Vec<_>>(), [0, 1, 2, 3, 4, 9]);
        assert!(
            sample(&mut raster, &info, 2, &points, &|| false)
                .unwrap_err()
                .contains("band 2")
        );
        let cancelled = sample(&mut raster, &info, 1, &points, &|| true).unwrap_err();
        assert!(cancelled.contains("cancelled"));
    }
}

#[test]
fn polygonize_makes_one_area_per_patch_and_respects_its_limit() {
    let d = dir("poly");
    let path = d.join("classes.tif").to_string_lossy().into_owned();
    // 4 × 3: left half 1, right half 2, one nodata pixel.
    let values = vec![1.0, 1.0, 2.0, 2.0, 1.0, 1.0, 2.0, 2.0, 1.0, NODATA, 2.0, 2.0];
    write_f32(&path, values, (4, 3), T, Some(2056), NODATA, false).unwrap();
    let (mut raster, info) = open(&path).unwrap();
    let (schema, batches) = polygonize(&mut raster, &info, 1, MAX_RASTER_CELLS).unwrap();
    assert!(schema.index_of("geometry").is_ok());
    let value = schema.index_of("value").unwrap();
    let mut found: Vec<f64> = batches
        .iter()
        .flat_map(|b| {
            let a = b.column(value).as_primitive::<Float64Type>().clone();
            (0..a.len()).map(move |i| a.value(i)).collect::<Vec<_>>()
        })
        .collect();
    found.sort_by(f64::total_cmp);
    assert_eq!(found, vec![1.0, 2.0], "nodata is left out");
    let refused = polygonize(&mut raster, &info, 1, 11).unwrap_err();
    assert!(
        refused.contains("12 cells") && refused.contains("at most 11"),
        "{refused}"
    );
}

/// The rasters `rust/web/raster.spec.js` serves to the browser: `GM_RASTER_OUT=<dir> cargo test
/// --release -p geomarmot-io --test raster write_browser_rasters -- --ignored`.
#[test]
#[ignore = "writes the browser test's rasters"]
fn write_browser_rasters() {
    let out = std::path::PathBuf::from(std::env::var("GM_RASTER_OUT").unwrap());
    std::fs::create_dir_all(&out).unwrap();
    let side = 4096;
    let values: Vec<f32> = (0..side * side)
        .map(|i| ((i / side) * 1000 + i % side) as f32)
        .collect();
    write_f32(
        &out.join("gradient.tif").to_string_lossy(),
        values,
        (side, side),
        T,
        Some(2056),
        NODATA,
        true,
    )
    .unwrap();
    let classes = vec![1.0, 1.0, 2.0, 2.0, 1.0, 1.0, 2.0, 2.0, 1.0, NODATA, 2.0, 2.0];
    write_f32(
        &out.join("classes.tif").to_string_lossy(),
        classes,
        (4, 3),
        T,
        Some(2056),
        NODATA,
        true,
    )
    .unwrap();
}
