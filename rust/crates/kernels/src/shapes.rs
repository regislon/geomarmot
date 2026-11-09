//! Reshaping kernels: densify (as JTS's Densifier) and Chaikin smoothing (as the JavaScript app's).

use geo::{Coord, Geometry, LineString, MultiLineString, MultiPolygon, Polygon};

/// Rewrites one line or ring: (its coordinates, whether it is closed) → new coordinates.
type LineFn<'a> = &'a dyn Fn(&[Coord<f64>], bool) -> Vec<Coord<f64>>;

/// Apply `f(coords, closed)` to every line and ring; points and empties pass through.
fn map_lines(g: &Geometry<f64>, f: LineFn) -> Geometry<f64> {
    let ring = |r: &LineString<f64>| LineString(f(&r.0, true));
    let polygon = |p: &Polygon<f64>| Polygon::new(ring(p.exterior()), p.interiors().iter().map(ring).collect());
    match g {
        Geometry::LineString(l) => LineString(f(&l.0, false)).into(),
        Geometry::Polygon(p) => polygon(p).into(),
        Geometry::MultiLineString(m) => {
            MultiLineString(m.0.iter().map(|l| LineString(f(&l.0, false))).collect()).into()
        }
        Geometry::MultiPolygon(m) => MultiPolygon(m.0.iter().map(polygon).collect()).into(),
        Geometry::GeometryCollection(c) => {
            Geometry::GeometryCollection(geo::GeometryCollection(c.0.iter().map(|g| map_lines(g, f)).collect()))
        }
        other => other.clone(),
    }
}

/// Every segment longer than `tolerance` split evenly into `floor(len / tolerance) + 1` parts
/// (JTS Densifier.densifyPoints). Polygons still need JTS's `buffer(0)`, which the SQL does.
pub fn densify(g: &Geometry<f64>, tolerance: f64) -> Geometry<f64> {
    map_lines(g, &|pts, _| {
        let mut out: Vec<Coord<f64>> = Vec::with_capacity(pts.len());
        let mut add = |c: Coord<f64>| {
            if out.last() != Some(&c) {
                out.push(c);
            }
        };
        for w in pts.windows(2) {
            let (a, b) = (w[0], w[1]);
            add(a);
            let len = (b.x - a.x).hypot(b.y - a.y);
            if len <= tolerance {
                continue;
            }
            let count = (len / tolerance) as usize + 1;
            let step = len / count as f64;
            for j in 1..count {
                let t = j as f64 * step / len;
                add(Coord {
                    x: a.x + t * (b.x - a.x),
                    y: a.y + t * (b.y - a.y),
                });
            }
        }
        if let Some(last) = pts.last() {
            add(*last);
        }
        out
    })
}

/// Chaikin corner cutting, `passes` times; a line keeps its ends, and a line or ring with fewer
/// than four points is left alone (app/src/engines/jsts.js).
pub fn chaikin(g: &Geometry<f64>, passes: usize) -> Geometry<f64> {
    map_lines(g, &|pts, closed| {
        let mut c = pts.to_vec();
        for _ in 0..passes {
            if c.len() < 4 {
                break;
            }
            let mut out = Vec::with_capacity(2 * c.len());
            if !closed {
                out.push(c[0]);
            }
            for w in c.windows(2) {
                let (a, b) = (w[0], w[1]);
                out.push(a * 0.75 + b * 0.25);
                out.push(a * 0.25 + b * 0.75);
            }
            out.push(if closed { out[0] } else { c[c.len() - 1] });
            c = out;
        }
        c
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn densifies_and_smooths_like_the_fixtures() {
        let line: Geometry<f64> = LineString::from(vec![(0., 0.), (2., 0.)]).into();
        let Geometry::LineString(d) = densify(&line, 0.5) else {
            panic!()
        };
        assert_eq!(d.0.len(), 6, "floor(2 / 0.5) + 1 = 5 segments");
        let corner: Geometry<f64> = LineString::from(vec![(0., 0.), (2., 0.), (2., 2.), (4., 2.)]).into();
        let Geometry::LineString(s) = chaikin(&corner, 1) else {
            panic!()
        };
        assert_eq!(s.0.len(), 8);
        assert_eq!((s.0[1].x, s.0[1].y), (0.5, 0.0));
    }
}
