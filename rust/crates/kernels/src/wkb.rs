//! 2D WKB to `geo` and back, for the per-feature kernels: every type, Z and M dropped.

use geo::{Coord, Geometry, GeometryCollection, LineString, MultiLineString, MultiPoint, MultiPolygon, Point, Polygon};
use geomarmot_sql::Result;

/// A WKB geometry (any type, any byte order) as `geo`, through its coordinates.
pub fn read(bytes: &[u8]) -> Result<Geometry<f64>> {
    Reader { b: bytes, i: 0 }.geometry()
}

/// Little-endian 2D WKB.
pub fn write(g: &Geometry<f64>) -> Vec<u8> {
    let mut out = Vec::new();
    put(g, &mut out);
    out
}

fn put(g: &Geometry<f64>, out: &mut Vec<u8>) {
    fn header(out: &mut Vec<u8>, kind: u32, n: usize) {
        out.push(1);
        out.extend(kind.to_le_bytes());
        out.extend((n as u32).to_le_bytes());
    }
    fn coords(out: &mut Vec<u8>, ring: &LineString<f64>) {
        out.extend((ring.0.len() as u32).to_le_bytes());
        for c in &ring.0 {
            out.extend(c.x.to_le_bytes());
            out.extend(c.y.to_le_bytes());
        }
    }
    fn polygon(out: &mut Vec<u8>, p: &Polygon<f64>) {
        header(out, 3, 1 + p.interiors().len());
        coords(out, p.exterior());
        p.interiors().iter().for_each(|r| coords(out, r));
    }
    match g {
        Geometry::Point(p) => {
            out.push(1);
            out.extend(1u32.to_le_bytes());
            out.extend(p.x().to_le_bytes());
            out.extend(p.y().to_le_bytes());
        }
        Geometry::LineString(l) => {
            out.push(1);
            out.extend(2u32.to_le_bytes());
            coords(out, l);
        }
        Geometry::Polygon(p) => polygon(out, p),
        Geometry::MultiPoint(m) => {
            header(out, 4, m.0.len());
            m.0.iter().for_each(|p| put(&(*p).into(), out));
        }
        Geometry::MultiLineString(m) => {
            header(out, 5, m.0.len());
            m.0.iter().for_each(|l| put(&l.clone().into(), out));
        }
        Geometry::MultiPolygon(m) => {
            header(out, 6, m.0.len());
            m.0.iter().for_each(|p| polygon(out, p));
        }
        Geometry::GeometryCollection(c) => {
            header(out, 7, c.0.len());
            c.0.iter().for_each(|g| put(g, out));
        }
        _ => unreachable!("kernels never build a Line, Rect or Triangle"),
    }
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn take<const N: usize>(&mut self, little: bool) -> Result<[u8; N]> {
        let mut s: [u8; N] = self
            .b
            .get(self.i..self.i + N)
            .ok_or("WKB: truncated")?
            .try_into()
            .unwrap();
        self.i += N;
        if !little {
            s.reverse();
        }
        Ok(s)
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
    fn polygon(&mut self, little: bool, dims: usize) -> Result<Polygon<f64>> {
        let n = self.u32(little)?;
        let mut rings: Vec<LineString<f64>> = (0..n).map(|_| self.line(little, dims)).collect::<Result<_>>()?;
        if rings.is_empty() {
            rings.push(LineString(vec![]));
        }
        let exterior = rings.remove(0);
        Ok(Polygon::new(exterior, rings))
    }
    fn parts(&mut self, little: bool) -> Result<Vec<Geometry<f64>>> {
        let n = self.u32(little)?;
        (0..n).map(|_| self.geometry()).collect()
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
            3 => self.polygon(little, dims)?.into(),
            4 => MultiPoint(
                self.parts(little)?
                    .into_iter()
                    .filter_map(|g| Point::try_from(g).ok())
                    .collect(),
            )
            .into(),
            5 => MultiLineString(
                self.parts(little)?
                    .into_iter()
                    .filter_map(|g| LineString::try_from(g).ok())
                    .collect(),
            )
            .into(),
            6 => MultiPolygon(
                self.parts(little)?
                    .into_iter()
                    .filter_map(|g| Polygon::try_from(g).ok())
                    .collect(),
            )
            .into(),
            7 => Geometry::GeometryCollection(GeometryCollection(self.parts(little)?)),
            other => return Err(format!("WKB: unsupported type {other}")),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_type() {
        let square = Polygon::new(LineString::from(vec![(0., 0.), (1., 0.), (1., 1.), (0., 0.)]), vec![]);
        let line = LineString::from(vec![(0., 0.), (2., 1.)]);
        let all: Vec<Geometry<f64>> = vec![
            Point::new(1., 2.).into(),
            line.clone().into(),
            square.clone().into(),
            MultiPoint(vec![Point::new(1., 2.)]).into(),
            MultiLineString(vec![line.clone()]).into(),
            MultiPolygon(vec![square.clone()]).into(),
            Geometry::GeometryCollection(GeometryCollection(vec![line.into(), square.into()])),
        ];
        for g in all {
            assert_eq!(read(&write(&g)).unwrap(), g);
        }
    }
}
