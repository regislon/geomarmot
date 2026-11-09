//! The overlay core on native GEOS. Port of `app/src/engines/geos/core.js`.
//!
//! 1. Noding: the union of every part's boundary (OverlayNG floating noding).
//! 2. Faces: polygonize the noded lines.
//! 3. Provenance: one interior point per face, certified to lie more than `tau` from the
//!    face's boundary, then the parts that properly contain it. A face where no such
//!    point is found is ambiguous: its covering parts are left empty, never guessed.

use geos::{Geom, Geometry, GeometryTypes};

const POLYLABEL_TOLERANCE_FRACTION: f64 = 0.1;

/// One task's faces. `members[f]` are indices into the task's parts.
pub struct TaskResult {
    pub faces: Vec<Vec<u8>>,
    pub areas: Vec<f64>,
    pub bounds: Vec<[f64; 4]>,
    pub members: Vec<Vec<usize>>,
    pub clearance: Vec<f64>,
    pub ambiguous: Vec<bool>,
}

fn e(err: geos::Error) -> String {
    err.to_string()
}

pub fn envelope(g: &impl Geom) -> Result<[f64; 4], String> {
    Ok([
        g.get_x_min().map_err(e)?,
        g.get_y_min().map_err(e)?,
        g.get_x_max().map_err(e)?,
        g.get_y_max().map_err(e)?,
    ])
}

/// Short side of the face's minimum rotated rectangle (0 when it degenerates).
fn min_width(face: &impl Geom) -> Result<f64, String> {
    let rect = face.minimum_rotated_rectangle().map_err(e)?;
    if rect.geometry_type().map_err(e)? != GeometryTypes::Polygon {
        return Ok(0.0);
    }
    let ring = rect.get_exterior_ring().map_err(e)?;
    let seq = ring.get_coord_seq().map_err(e)?;
    let p = |i| -> Result<(f64, f64), String> { Ok((seq.get_x(i).map_err(e)?, seq.get_y(i).map_err(e)?)) };
    let (a, b, c) = (p(0)?, p(1)?, p(2)?);
    Ok((b.0 - a.0).hypot(b.1 - a.1).min((c.0 - b.0).hypot(c.1 - b.1)))
}

/// Interior point and its clearance: point on surface, then (if too close to the boundary and the face is
/// wide enough) the maximum inscribed circle at tolerance tau/10.
// ponytail: core.js tries the widest constrained-Delaunay incentre before the inscribed circle, as a cheaper
// step; the safe geos crate does not wrap that call. Skipping it changes cost, not results: any certified
// point gives the same covering parts. Add it back if the checkpoint shows fallback faces dominate.
fn interior_point(face: &impl Geom, tau: f64) -> Result<(Geometry, f64), String> {
    let boundary = face.boundary().map_err(e)?;
    let point = face.point_on_surface().map_err(e)?;
    let c = point.distance(&boundary).map_err(e)?;
    if c <= tau && min_width(face)? > 2.0 * tau {
        let circle = face
            .maximum_inscribed_circle(tau * POLYLABEL_TOLERANCE_FRACTION)
            .map_err(e)?;
        return Ok((circle.get_start_point().map_err(e)?, circle.length().map_err(e)?));
    }
    Ok((point, c))
}

/// Overlay `parts` (WKB polygons) into faces carrying the parts that cover them.
pub fn overlay_parts(parts_wkb: &[&[u8]], tau: f64) -> Result<TaskResult, String> {
    let parts: Vec<Geometry> = parts_wkb
        .iter()
        .map(|w| Geometry::new_from_wkb(w).map_err(e))
        .collect::<Result<_, _>>()?;
    let boundaries: Vec<Geometry> = parts
        .iter()
        .map(|p| p.boundary().map_err(e))
        .collect::<Result<_, _>>()?;
    let noded = Geometry::create_geometry_collection(boundaries)
        .map_err(e)?
        .unary_union()
        .map_err(e)?;
    let faces = Geometry::polygonize(&[noded]).map_err(e)?;
    let n = faces.get_num_geometries().map_err(e)?;
    let mut out = TaskResult {
        faces: vec![],
        areas: vec![],
        bounds: vec![],
        members: vec![vec![]; n],
        clearance: vec![],
        ambiguous: vec![],
    };
    let mut points = Vec::with_capacity(n);
    for i in 0..n {
        let face = faces.get_geometry_n(i).map_err(e)?;
        let (point, c) = interior_point(&face, tau)?;
        out.faces.push(face.to_wkb().map_err(e)?);
        out.areas.push(face.area().map_err(e)?);
        out.bounds.push(envelope(&face)?);
        out.clearance.push(c);
        out.ambiguous.push(c <= tau);
        points.push((point.get_x().map_err(e)?, point.get_y().map_err(e)?, point));
    }
    // Containment: each part prepared once, tested against the certified points in its envelope (sorted by x).
    let mut order: Vec<usize> = (0..n).filter(|&i| !out.ambiguous[i]).collect();
    order.sort_by(|&i, &j| points[i].0.total_cmp(&points[j].0));
    let xs: Vec<f64> = order.iter().map(|&i| points[i].0).collect();
    for (k, part) in parts.iter().enumerate() {
        let [x0, y0, x1, y1] = envelope(part)?;
        let prepared = part.to_prepared_geom().map_err(e)?;
        let mut s = xs.partition_point(|&x| x < x0);
        while s < xs.len() && xs[s] <= x1 {
            let i = order[s];
            let (_, y, ref p) = points[i];
            if (y0..=y1).contains(&y) && prepared.contains_properly(p).map_err(e)? {
                out.members[i].push(k);
            }
            s += 1;
        }
    }
    Ok(out)
}
