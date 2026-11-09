//! The overlay core in pure Rust (`geo`), for targets without GEOS (the browser).
//!
//! Instead of noding every boundary and polygonizing, parts are added one at a time and
//! every face they touch is split into its intersection and difference with the part.
//! Each face therefore carries its covering parts exactly, by construction. Faces are
//! still certified: one whose interior point lies within `tau` of its boundary is
//! ambiguous and gets no parts, as in the GEOS core.
// ponytail: incremental splitting is O(parts × faces) per task; clusters keep tasks small. Measure at the checkpoint.

use geo::{Area, BooleanOps, BoundingRect, Distance, Euclidean, InteriorPoint, MultiPolygon, Polygon};

use super::TaskResult;
use super::wkb::{read_polygon, write_polygon};

fn boxes_meet(a: &Polygon<f64>, b: &Polygon<f64>) -> bool {
    match (a.bounding_rect(), b.bounding_rect()) {
        (Some(a), Some(b)) => {
            a.min().x <= b.max().x && b.min().x <= a.max().x && a.min().y <= b.max().y && b.min().y <= a.max().y
        }
        _ => false,
    }
}

fn clearance(face: &Polygon<f64>) -> f64 {
    let Some(point) = face.interior_point() else { return 0.0 };
    std::iter::once(face.exterior())
        .chain(face.interiors())
        .map(|ring| Euclidean.distance(&point, ring))
        .fold(f64::INFINITY, f64::min)
}

pub fn overlay_parts(parts_wkb: &[&[u8]], tau: f64) -> Result<TaskResult, String> {
    let mut faces: Vec<(Polygon<f64>, Vec<usize>)> = Vec::new();
    for (k, wkb) in parts_wkb.iter().enumerate() {
        let part = read_polygon(wkb)?;
        let part_mp = MultiPolygon(vec![part.clone()]);
        let mut rest = part_mp.clone();
        let mut next = Vec::with_capacity(faces.len() + 2);
        for (face, members) in faces.drain(..) {
            if !boxes_meet(&face, &part) {
                next.push((face, members));
                continue;
            }
            let face_mp = MultiPolygon(vec![face]);
            for p in face_mp.intersection(&part_mp) {
                let mut m = members.clone();
                m.push(k);
                next.push((p, m));
            }
            for p in face_mp.difference(&part_mp) {
                next.push((p, members.clone()));
            }
            rest = rest.difference(&face_mp);
        }
        next.extend(rest.into_iter().map(|p| (p, vec![k])));
        faces = next.into_iter().filter(|(p, _)| p.unsigned_area() > 0.0).collect();
    }
    let mut out = TaskResult {
        faces: vec![],
        areas: vec![],
        bounds: vec![],
        members: vec![],
        clearance: vec![],
        ambiguous: vec![],
    };
    for (face, members) in faces {
        let c = clearance(&face);
        let r = face.bounding_rect().ok_or("an empty face")?;
        out.faces.push(write_polygon(&face));
        out.areas.push(face.unsigned_area());
        out.bounds.push([r.min().x, r.min().y, r.max().x, r.max().y]);
        out.ambiguous.push(c <= tau);
        out.members.push(if c <= tau { vec![] } else { members });
        out.clearance.push(c);
    }
    Ok(out)
}
