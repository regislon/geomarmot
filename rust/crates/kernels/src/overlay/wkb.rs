//! Minimal WKB for the pure-Rust overlay: 2D polygons in, 2D polygons out.

use geo::{Coord, LineString, Polygon};

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
    little: bool,
}

impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N], String> {
        let s = self.b.get(self.i..self.i + N).ok_or("WKB: truncated")?;
        self.i += N;
        Ok(s.try_into().unwrap())
    }
    fn u32(&mut self) -> Result<u32, String> {
        let b = self.take::<4>()?;
        Ok(if self.little {
            u32::from_le_bytes(b)
        } else {
            u32::from_be_bytes(b)
        })
    }
    fn f64(&mut self) -> Result<f64, String> {
        let b = self.take::<8>()?;
        Ok(if self.little {
            f64::from_le_bytes(b)
        } else {
            f64::from_be_bytes(b)
        })
    }
}

/// A 2D WKB polygon.
// ponytail: Z/M polygons are refused, not flattened; the GEOS kernel handles them, add here when the browser needs it.
pub fn read_polygon(bytes: &[u8]) -> Result<Polygon<f64>, String> {
    let mut r = Reader {
        b: bytes,
        i: 1,
        little: bytes.first() == Some(&1),
    };
    let kind = r.u32()?;
    if kind != 3 {
        return Err(format!("WKB: expected a 2D polygon, got type {kind}"));
    }
    let mut rings = Vec::new();
    for _ in 0..r.u32()? {
        let n = r.u32()? as usize;
        let mut coords = Vec::with_capacity(n);
        for _ in 0..n {
            coords.push(Coord {
                x: r.f64()?,
                y: r.f64()?,
            });
        }
        rings.push(LineString(coords));
    }
    let mut rings = rings.into_iter();
    let exterior = rings.next().unwrap_or_else(|| LineString(vec![]));
    Ok(Polygon::new(exterior, rings.collect()))
}

/// Little-endian 2D WKB.
pub fn write_polygon(p: &Polygon<f64>) -> Vec<u8> {
    let mut out = vec![1u8];
    out.extend(3u32.to_le_bytes());
    let rings: Vec<&LineString<f64>> = std::iter::once(p.exterior()).chain(p.interiors()).collect();
    out.extend((rings.len() as u32).to_le_bytes());
    for ring in rings {
        out.extend((ring.0.len() as u32).to_le_bytes());
        for c in &ring.0 {
            out.extend(c.x.to_le_bytes());
            out.extend(c.y.to_le_bytes());
        }
    }
    out
}
