//! Filling polygons with H3 cells (h3o's tiler), under the fill modes the app offers
//! (app/src/engines/h3/geometry.js, FILL_MODES).

use geo::{BoundingRect, Geometry, Intersects, LineString, Polygon, Rect};
use h3o::geom::{ContainmentMode, TilerBuilder};
use h3o::{CellIndex, Resolution};

/// The cells covering a polygon or multipolygon; anything else has none.
pub fn fill(g: &Geometry<f64>, resolution: u8, mode: &str) -> Result<Vec<CellIndex>, String> {
    let resolution = Resolution::try_from(resolution).map_err(|e| e.to_string())?;
    let parts: Vec<Polygon<f64>> = match g {
        Geometry::Polygon(p) => vec![p.clone()],
        Geometry::MultiPolygon(m) => m.0.clone(),
        _ => return Ok(vec![]),
    };
    let containment = match mode {
        "ContainsBoundary" => ContainmentMode::ContainsBoundary,
        "Covers" | "CoversBoundingBox" => ContainmentMode::Covers,
        _ => ContainmentMode::ContainsCentroid,
    };
    let mut tiler = TilerBuilder::new(resolution).containment_mode(containment).build();
    for p in &parts {
        tiler.add(p.clone()).map_err(|e| e.to_string())?;
    }
    let mut cells: Vec<CellIndex> = tiler.into_coverage().collect();
    if mode == "CoversBoundingBox" {
        // H3's containmentOverlappingBbox: a cell counts when its bounding box, scaled by 1.1 × 1.4
        // about its centre (cellToBBox with coverChildren), overlaps the shape. Such a cell lies within two
        // rings of a covering cell, so those are the candidates.
        cells = cells
            .iter()
            .flat_map(|c| c.grid_disk::<Vec<_>>(2))
            .filter(|c| {
                let ring: LineString<f64> = c.boundary().iter().map(|ll| (ll.lng(), ll.lat())).collect();
                ring.bounding_rect().is_some_and(|r| {
                    let (centre, half) = (r.center(), (r.max() - r.min()) * (1.1 * 1.4 / 2.0));
                    let scaled = Rect::new(centre - half, centre + half);
                    parts.iter().any(|p| p.intersects(&scaled))
                })
            })
            .collect();
    }
    cells.sort_unstable();
    cells.dedup();
    Ok(cells)
}
