//! Port of `tests/harness/wkt.js`: WKT as written, Z kept, for exact comparison.

#[derive(Debug, Clone)]
pub enum Body {
    Point(Vec<f64>),
    Line(Vec<Vec<f64>>),
    Polygon(Vec<Vec<Vec<f64>>>),
    MultiPoint(Vec<Vec<f64>>),
    MultiLine(Vec<Vec<Vec<f64>>>),
    MultiPolygon(Vec<Vec<Vec<Vec<f64>>>>),
    Collection(Vec<Geom>),
}

#[derive(Debug, Clone)]
pub struct Geom {
    pub kind: String,
    pub z: bool,
    /// None when EMPTY.
    pub body: Option<Body>,
}

struct P<'a> {
    s: &'a [u8],
    i: usize,
    src: &'a str,
}

impl P<'_> {
    fn skip(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }
    fn word(&mut self) -> String {
        self.skip();
        let start = self.i;
        while self.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
            self.i += 1;
        }
        self.src[start..self.i].to_uppercase()
    }
    fn expect(&mut self, ch: u8) -> Result<(), String> {
        self.skip();
        if self.peek() != Some(ch) {
            return Err(format!(
                "WKT: expected \"{}\" at {} in {}",
                ch as char, self.i, self.src
            ));
        }
        self.i += 1;
        Ok(())
    }
    fn number(&mut self) -> Result<f64, String> {
        self.skip();
        let start = self.i;
        while self.peek().is_some_and(|c| b"-+0123456789.eE".contains(&c)) {
            self.i += 1;
        }
        let text = &self.src[start..self.i];
        text.parse()
            .map_err(|_| format!("WKT: expected a number at {start} in {}", self.src))
    }
    fn point(&mut self) -> Result<Vec<f64>, String> {
        let mut c = vec![self.number()?, self.number()?];
        self.skip();
        while self.peek().is_some_and(|ch| b"-+0123456789.".contains(&ch)) {
            c.push(self.number()?);
            self.skip();
        }
        Ok(c)
    }
    fn list<T>(&mut self, item: &mut dyn FnMut(&mut Self) -> Result<T, String>) -> Result<Vec<T>, String> {
        self.expect(b'(')?;
        let mut out = vec![item(self)?];
        self.skip();
        while self.peek() == Some(b',') {
            self.i += 1;
            out.push(item(self)?);
            self.skip();
        }
        self.expect(b')')?;
        Ok(out)
    }
    fn maybe_paren_point(&mut self) -> Result<Vec<f64>, String> {
        self.skip();
        if self.peek() == Some(b'(') {
            self.i += 1;
            let p = self.point()?;
            self.expect(b')')?;
            return Ok(p);
        }
        self.point()
    }
    fn ring(&mut self) -> Result<Vec<Vec<f64>>, String> {
        self.list(&mut |p| p.point())
    }
    fn polygon(&mut self) -> Result<Vec<Vec<Vec<f64>>>, String> {
        self.list(&mut |p| p.ring())
    }
    fn geometry(&mut self) -> Result<Geom, String> {
        let kind = self.word();
        let modifier = self.word();
        let z = matches!(modifier.as_str(), "Z" | "ZM");
        match modifier.as_str() {
            "" | "Z" | "ZM" | "M" => {}
            "EMPTY" => return Ok(Geom { kind, z, body: None }),
            other => return Err(format!("WKT: unexpected \"{other}\"")),
        }
        self.skip();
        if self.src[self.i..].to_uppercase().starts_with("EMPTY") {
            self.i += 5;
            return Ok(Geom { kind, z, body: None });
        }
        let body = match kind.as_str() {
            "POINT" => {
                self.expect(b'(')?;
                let p = self.point()?;
                self.expect(b')')?;
                Body::Point(p)
            }
            "LINESTRING" => Body::Line(self.ring()?),
            "POLYGON" => Body::Polygon(self.polygon()?),
            "MULTIPOINT" => Body::MultiPoint(self.list(&mut |p| p.maybe_paren_point())?),
            "MULTILINESTRING" => Body::MultiLine(self.list(&mut |p| p.ring())?),
            "MULTIPOLYGON" => Body::MultiPolygon(self.list(&mut |p| p.polygon())?),
            "GEOMETRYCOLLECTION" => Body::Collection(self.list(&mut |p| p.geometry())?),
            other => return Err(format!("WKT: unsupported type {other}")),
        };
        Ok(Geom {
            kind,
            z,
            body: Some(body),
        })
    }
}

pub fn parse(text: &str) -> Result<Geom, String> {
    let src = text.trim();
    let mut p = P {
        s: src.as_bytes(),
        i: 0,
        src,
    };
    let g = p.geometry()?;
    p.skip();
    if p.i != src.len() {
        return Err(format!("WKT: trailing text in {src}"));
    }
    Ok(g)
}
