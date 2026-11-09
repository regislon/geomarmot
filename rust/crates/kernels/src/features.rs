//! Per-feature kernels: one value in, one geometry out, pure Rust (native and wasm).
//!
//! `drive` reads (key, value) rows as Arrow, applies the kernel, and writes (key, geometry)
//! back through the engine; it is the same code on every engine.

use std::sync::Arc;

use geo::{ConvexHull, Coord, CoordsIter, Geometry, LineString, Point, Polygon};
use geomarmot_sql::arrow::array::{Array, ArrayRef, AsArray, BinaryArray, RecordBatch};
use geomarmot_sql::arrow::datatypes::{DataType, Field, Schema};
use geomarmot_sql::{KernelRequest, Result, SqlEngine, qid};

/// The kernels by name.
pub const OPS: &[&str] = &[
    "minimum_bounding_circle",
    "h3_cell_boundary",
    "aeqd_forward",
    "aeqd_inverse",
];

/// Segments per quadrant of a circle, as JTS buffers a point (MinimumBoundingCircle.getCircle).
const QUADRANT_SEGMENTS: usize = 8;

/// The smallest circle around a set of points (Welzl, iterative, after a convex hull).
fn enclosing_circle(points: &[Coord<f64>]) -> Option<(Coord<f64>, f64)> {
    let dist = |a: Coord<f64>, b: Coord<f64>| (a.x - b.x).hypot(a.y - b.y);
    let from2 = |a: Coord<f64>, b: Coord<f64>| {
        (
            Coord {
                x: (a.x + b.x) / 2.0,
                y: (a.y + b.y) / 2.0,
            },
            dist(a, b) / 2.0,
        )
    };
    let from3 = |a: Coord<f64>, b: Coord<f64>, c: Coord<f64>| {
        let d = 2.0 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
        if d.abs() < f64::EPSILON {
            return None;
        }
        let (a2, b2, c2) = (a.x * a.x + a.y * a.y, b.x * b.x + b.y * b.y, c.x * c.x + c.y * c.y);
        let centre = Coord {
            x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
            y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
        };
        Some((centre, dist(centre, a)))
    };
    let inside = |c: &(Coord<f64>, f64), p: Coord<f64>| dist(c.0, p) <= c.1 * (1.0 + 1e-12) + 1e-15;
    let mut circle = (*points.first()?, 0.0);
    for i in 0..points.len() {
        if inside(&circle, points[i]) {
            continue;
        }
        circle = (points[i], 0.0);
        for j in 0..i {
            if inside(&circle, points[j]) {
                continue;
            }
            circle = from2(points[i], points[j]);
            for k in 0..j {
                if !inside(&circle, points[k]) {
                    circle = from3(points[i], points[j], points[k]).unwrap_or(circle);
                }
            }
        }
    }
    Some(circle)
}

/// The circle as JTS writes it: start east, clockwise, 4 × 8 segments.
pub fn minimum_bounding_circle(g: &Geometry<f64>) -> Option<Geometry<f64>> {
    let hull: Vec<Coord<f64>> = g.convex_hull().exterior().0.clone();
    let points = if hull.is_empty() {
        g.coords_iter().collect()
    } else {
        hull
    };
    let (c, r) = enclosing_circle(&points)?;
    if r == 0.0 {
        return Some(Point(c).into());
    }
    let n = 4 * QUADRANT_SEGMENTS;
    let ring: Vec<Coord<f64>> = (0..=n)
        .map(|k| {
            let a = -((k % n) as f64) * std::f64::consts::TAU / n as f64;
            Coord {
                x: c.x + r * a.cos(),
                y: c.y + r * a.sin(),
            }
        })
        .collect();
    Some(Polygon::new(LineString(ring), vec![]).into())
}

/// An H3 cell's hexagon (or pentagon), longitude/latitude, closed.
pub fn h3_cell_boundary(cell: &str) -> Option<Geometry<f64>> {
    let index: h3o::CellIndex = cell.trim().parse().ok()?;
    let mut ring: Vec<Coord<f64>> = index
        .boundary()
        .iter()
        .map(|ll| Coord {
            x: ll.lng(),
            y: ll.lat(),
        })
        .collect();
    ring.push(*ring.first()?);
    Some(Polygon::new(LineString(ring), vec![]).into())
}

/// PROJ's ellipsoidal `+proj=aeqd` centred on (lon0, lat0), WGS84: the geodesic distance and
/// azimuth from the centre (PROJ's e_forward / e_inverse, both through GeographicLib).
pub fn aeqd_forward(lon0: f64, lat0: f64, lon: f64, lat: f64) -> (f64, f64) {
    use geographiclib_rs::{Geodesic, InverseGeodesic};
    if (lat - lat0).abs() < 1e-10 && (lon - lon0).abs() < 1e-10 {
        return (0.0, 0.0);
    }
    let (s12, azi1, _, _): (f64, f64, f64, f64) = Geodesic::wgs84().inverse(lat0, lon0, lat, lon);
    let a = azi1.to_radians();
    (s12 * a.sin(), s12 * a.cos())
}

pub fn aeqd_inverse(lon0: f64, lat0: f64, x: f64, y: f64) -> (f64, f64) {
    use geographiclib_rs::{DirectGeodesic, Geodesic};
    let s = x.hypot(y);
    if s < 1e-10 {
        return (lon0, lat0);
    }
    let (lat, lon): (f64, f64) = Geodesic::wgs84().direct(lat0, lon0, x.atan2(y).to_degrees(), s);
    (lon, lat)
}

/// Rewrite every (x, y) of one WKB geometry in place; returns its length in bytes. The type,
/// parts, rings and extra ordinates (Z, M) are kept as they are.
fn map_coords(b: &mut [u8], f: &mut dyn FnMut(f64, f64) -> (f64, f64)) -> Result<usize> {
    let little = *b.first().ok_or("WKB: empty")? == 1;
    let u32_at = |b: &[u8], i: usize| -> Result<u32> {
        let s: [u8; 4] = b.get(i..i + 4).ok_or("WKB: truncated")?.try_into().unwrap();
        Ok(if little {
            u32::from_le_bytes(s)
        } else {
            u32::from_be_bytes(s)
        })
    };
    let raw = u32_at(b, 1)?;
    let base = raw & 0xffff;
    let (kind, iso) = (base % 1000, base / 1000);
    let dims = 2
        + usize::from(iso == 1 || iso == 2)
        + 2 * usize::from(iso == 3)
        + usize::from(raw & 0x8000_0000 != 0)
        + usize::from(raw & 0x4000_0000 != 0);
    let mut i = 5;
    let mut coords = |b: &mut [u8], i: &mut usize, n: u32| -> Result<()> {
        for _ in 0..n {
            let at = |b: &[u8], k: usize| -> Result<f64> {
                let s: [u8; 8] = b.get(k..k + 8).ok_or("WKB: truncated")?.try_into().unwrap();
                Ok(if little {
                    f64::from_le_bytes(s)
                } else {
                    f64::from_be_bytes(s)
                })
            };
            let (x, y) = f(at(b, *i)?, at(b, *i + 8)?);
            let put = |v: f64| if little { v.to_le_bytes() } else { v.to_be_bytes() };
            b[*i..*i + 8].copy_from_slice(&put(x));
            b[*i + 8..*i + 16].copy_from_slice(&put(y));
            *i += 8 * dims;
        }
        Ok(())
    };
    match kind {
        1 => coords(b, &mut i, 1)?,
        2 => {
            let n = u32_at(b, i)?;
            i += 4;
            coords(b, &mut i, n)?;
        }
        3 => {
            let rings = u32_at(b, i)?;
            i += 4;
            for _ in 0..rings {
                let n = u32_at(b, i)?;
                i += 4;
                coords(b, &mut i, n)?;
            }
        }
        4..=7 => {
            let parts = u32_at(b, i)?;
            i += 4;
            for _ in 0..parts {
                i += map_coords(&mut b[i..], f)?;
            }
        }
        other => return Err(format!("WKB: unsupported type {other}")),
    }
    Ok(i)
}

/// The value is a two-part collection, (centre point, geometry): the geometry with each
/// coordinate moved by `f(centre, x, y)`.
fn about_centre(bytes: &[u8], f: fn(f64, f64, f64, f64) -> (f64, f64)) -> Result<Vec<u8>> {
    let mut b = bytes.to_vec();
    let mut centre = None;
    let point = map_coords(&mut b[9..], &mut |x, y| {
        centre = Some((x, y));
        (x, y)
    })?;
    let (lon0, lat0) = centre.ok_or("centre missing")?;
    let mut geometry = b[9 + point..].to_vec();
    map_coords(&mut geometry, &mut |x, y| f(lon0, lat0, x, y))?;
    Ok(geometry)
}

fn wkb(g: &Geometry<f64>) -> Vec<u8> {
    let mut out = Vec::new();
    write_wkb(g, &mut out);
    out
}

/// Little-endian 2D WKB for points and polygons (what the kernels produce).
fn write_wkb(g: &Geometry<f64>, out: &mut Vec<u8>) {
    let coords = |out: &mut Vec<u8>, ring: &LineString<f64>| {
        out.extend((ring.0.len() as u32).to_le_bytes());
        for c in &ring.0 {
            out.extend(c.x.to_le_bytes());
            out.extend(c.y.to_le_bytes());
        }
    };
    out.push(1);
    match g {
        Geometry::Point(p) => {
            out.extend(1u32.to_le_bytes());
            out.extend(p.x().to_le_bytes());
            out.extend(p.y().to_le_bytes());
        }
        Geometry::Polygon(p) => {
            out.extend(3u32.to_le_bytes());
            out.extend((1 + p.interiors().len() as u32).to_le_bytes());
            coords(out, p.exterior());
            p.interiors().iter().for_each(|r| coords(out, r));
        }
        _ => unreachable!("kernels produce points and polygons"),
    }
}

fn apply(op: &str, values: &dyn Array, i: usize) -> Result<Option<Vec<u8>>> {
    if values.is_null(i) {
        return Ok(None);
    }
    let g = match op {
        "minimum_bounding_circle" => {
            let bytes = values.as_binary::<i32>().value(i);
            minimum_bounding_circle(&read_wkb(bytes)?)
        }
        "aeqd_forward" | "aeqd_inverse" => {
            let bytes = values.as_binary::<i32>().value(i);
            let f = if op == "aeqd_forward" {
                aeqd_forward
            } else {
                aeqd_inverse
            };
            return about_centre(bytes, f).map(Some);
        }
        "h3_cell_boundary" => {
            let text = match values.data_type() {
                DataType::Utf8View => values.as_string_view().value(i).to_string(),
                _ => values.as_string::<i32>().value(i).to_string(),
            };
            h3_cell_boundary(&text)
        }
        other => return Err(format!("unknown kernel {other}")),
    };
    Ok(g.as_ref().map(wkb))
}

/// Read (key, value) rows, apply `op`, write (key, geometry) to `output`.
pub async fn drive(engine: &impl SqlEngine, r: &KernelRequest) -> Result<()> {
    let input = engine.query_arrow(&r.input_sql).await?;
    let mut out = Vec::with_capacity(input.len());
    for b in &input {
        let shapes: Vec<Option<Vec<u8>>> = (0..b.num_rows())
            .map(|i| apply(&r.op, b.column(1).as_ref(), i))
            .collect::<Result<_>>()?;
        let key: ArrayRef = b.column(0).clone();
        let schema = Arc::new(Schema::new(vec![
            Field::new("key", key.data_type().clone(), true),
            Field::new("wkb", DataType::Binary, true),
        ]));
        let wkb: ArrayRef = Arc::new(BinaryArray::from_iter(shapes));
        out.push(RecordBatch::try_new(schema, vec![key, wkb]).map_err(|e| e.to_string())?);
    }
    let raw = format!("{}__raw", r.output);
    engine.insert_arrow(&raw, &out).await?;
    engine
        .exec(&format!(
            "CREATE OR REPLACE TABLE {o} AS SELECT key, ST_GeomFromWKB(wkb) AS geometry FROM {raw}; DROP TABLE {raw};",
            o = qid(&r.output),
            raw = qid(&raw)
        ))
        .await
}

/// A 2D WKB geometry (any type) as `geo`, through its coordinates.
fn read_wkb(bytes: &[u8]) -> Result<Geometry<f64>> {
    let mut r = Reader { b: bytes, i: 0 };
    r.geometry()
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn take<const N: usize>(&mut self, little: bool) -> Result<[u8; N]> {
        let s: [u8; N] = self
            .b
            .get(self.i..self.i + N)
            .ok_or("WKB: truncated")?
            .try_into()
            .unwrap();
        self.i += N;
        Ok(if little {
            s
        } else {
            let mut s = s;
            s.reverse();
            s
        })
    }
    fn u32(&mut self, little: bool) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(little)?))
    }
    fn coord(&mut self, little: bool, dims: usize) -> Result<Coord<f64>> {
        let x = f64::from_le_bytes(self.take(little)?);
        let y = f64::from_le_bytes(self.take(little)?);
        for _ in 2..dims {
            self.take::<8>(little)?;
        }
        Ok(Coord { x, y })
    }
    fn line(&mut self, little: bool, dims: usize) -> Result<LineString<f64>> {
        let n = self.u32(little)?;
        Ok(LineString(
            (0..n).map(|_| self.coord(little, dims)).collect::<Result<_>>()?,
        ))
    }
    fn geometry(&mut self) -> Result<Geometry<f64>> {
        let little = *self.b.get(self.i).ok_or("WKB: empty")? == 1;
        self.i += 1;
        let raw = self.u32(little)?;
        // ISO (1000s) and EWKB (high bits) Z/M flags: only the extra ordinates matter here.
        let base = raw & 0xffff;
        let (kind, iso) = (base % 1000, base / 1000);
        let dims = 2
            + usize::from(iso == 1 || iso == 2)
            + 2 * usize::from(iso == 3)
            + usize::from(raw & 0x8000_0000 != 0)
            + usize::from(raw & 0x4000_0000 != 0);
        Ok(match kind {
            1 => Point(self.coord(little, dims)?).into(),
            2 => self.line(little, dims)?.into(),
            3 => {
                let n = self.u32(little)?;
                let mut rings: Vec<LineString<f64>> = (0..n).map(|_| self.line(little, dims)).collect::<Result<_>>()?;
                if rings.is_empty() {
                    rings.push(LineString(vec![]));
                }
                let exterior = rings.remove(0);
                Polygon::new(exterior, rings).into()
            }
            4..=7 => {
                let n = self.u32(little)?;
                let parts: Vec<Geometry<f64>> = (0..n).map(|_| self.geometry()).collect::<Result<_>>()?;
                Geometry::GeometryCollection(geo::GeometryCollection(parts))
            }
            other => return Err(format!("WKB: unsupported type {other}")),
        })
    }
}

#[cfg(test)]
mod aeqd_tests {
    use super::*;

    #[test]
    fn round_trips_and_measures_true_distance_from_the_centre() {
        let (lon0, lat0) = (101.25, -1.83);
        let (x, y) = aeqd_forward(lon0, lat0, 101.26, -1.83);
        assert!((x.hypot(y) - 1113.2).abs() < 1.0, "about 1.11 km east: {x} {y}");
        let (lon, lat) = aeqd_inverse(lon0, lat0, x, y);
        assert!((lon - 101.26).abs() < 1e-12 && (lat + 1.83).abs() < 1e-12);
    }

    #[test]
    fn keeps_the_geometry_type() {
        // GEOMETRYCOLLECTION(POINT(1 2), MULTIPOINT((1 2),(3 4))) in little-endian WKB.
        let mut b = vec![1, 7, 0, 0, 0, 2, 0, 0, 0];
        let point = |x: f64, y: f64| [vec![1, 1, 0, 0, 0], x.to_le_bytes().to_vec(), y.to_le_bytes().to_vec()].concat();
        b.extend(point(1.0, 2.0));
        b.extend([1, 4, 0, 0, 0, 2, 0, 0, 0]);
        b.extend(point(1.0, 2.0));
        b.extend(point(3.0, 4.0));
        let out = about_centre(&b, |cx, cy, x, y| (x - cx, y - cy)).unwrap();
        assert_eq!(&out[..9], &[1, 4, 0, 0, 0, 2, 0, 0, 0], "still a MULTIPOINT of 2");
        let g = read_wkb(&out).unwrap();
        let coords: Vec<_> = g.coords_iter().map(|c| (c.x, c.y)).collect();
        assert_eq!(coords, vec![(0.0, 0.0), (2.0, 2.0)]);
    }
}
