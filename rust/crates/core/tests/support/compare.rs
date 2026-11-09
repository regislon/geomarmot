//! Port of `tests/harness/compare.js`: a port's output against a fixture expectation.
//!
//! exact     same type, dimensions, parts in order, rings with the same start vertex
//!           and orientation, every coordinate within `tolerance` (`ignore` relaxes
//!           ringStart / orientation / partOrder).
//! topology  same type and dimensions, symmetric-difference area within
//!           `areaTolerance` of the expected area, discrete Hausdorff distance within
//!           `tolerance`, same validity. Uses `geo`, independent of DuckDB's spatial.

use geo::{Area, BooleanOps, Geometry, HausdorffDistance, MultiPolygon, Validation};
use serde_json::Value;

use super::wkt::{Body, Geom, parse};

#[derive(Clone)]
pub struct GeomOpts {
    pub mode: String,
    pub tolerance: f64,
    pub area_tolerance: f64,
    pub ignore: Vec<String>,
}

impl GeomOpts {
    pub fn from_case(v: Option<&Value>) -> Self {
        let get = |k: &str| v.and_then(|o| o.get(k));
        GeomOpts {
            mode: get("mode").and_then(Value::as_str).unwrap_or("exact").into(),
            tolerance: get("tolerance").and_then(Value::as_f64).unwrap_or(1e-9),
            area_tolerance: get("areaTolerance").and_then(Value::as_f64).unwrap_or(1e-6),
            ignore: get("ignore")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
                .unwrap_or_default(),
        }
    }
    fn ignores(&self, what: &str) -> bool {
        self.ignore.iter().any(|i| i == what)
    }
}

fn coords_equal(a: &[f64], b: &[f64], tol: f64) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| (x - y).abs() <= tol || (x.is_nan() && y.is_nan()))
}

fn list_equal(a: &[Vec<f64>], b: &[Vec<f64>], tol: f64) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(p, q)| coords_equal(p, q, tol))
}

fn ring_equal(a: &[Vec<f64>], b: &[Vec<f64>], o: &GeomOpts) -> bool {
    if list_equal(a, b, o.tolerance) {
        return true;
    }
    if a.len() != b.len() || a.len() < 4 {
        return false;
    }
    let (oa, ob) = (&a[..a.len() - 1], &b[..b.len() - 1]);
    let rotations: Vec<Vec<Vec<f64>>> = if o.ignores("ringStart") {
        (0..oa.len()).map(|k| [&oa[k..], &oa[..k]].concat()).collect()
    } else {
        vec![oa.to_vec()]
    };
    let mut candidates = vec![ob.to_vec()];
    if o.ignores("orientation") {
        let mut rev = b.to_vec();
        rev.reverse();
        candidates.push(rev[..rev.len() - 1].to_vec());
    }
    rotations
        .iter()
        .any(|r| candidates.iter().any(|c| list_equal(r, c, o.tolerance)))
}

fn polygon_equal(a: &[Vec<Vec<f64>>], b: &[Vec<Vec<f64>>], o: &GeomOpts) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(r, s)| ring_equal(r, s, o))
}

fn line_equal(a: &[Vec<f64>], b: &[Vec<f64>], o: &GeomOpts) -> bool {
    list_equal(a, b, o.tolerance)
        || (o.ignores("orientation") && list_equal(a, &b.iter().rev().cloned().collect::<Vec<_>>(), o.tolerance))
}

fn multi_equal<T>(a: &[T], b: &[T], o: &GeomOpts, eq: impl Fn(&T, &T) -> bool) -> bool {
    if a.len() != b.len() {
        return false;
    }
    if !o.ignores("partOrder") {
        return a.iter().zip(b).all(|(x, y)| eq(x, y));
    }
    let mut left: Vec<&T> = b.iter().collect();
    a.iter()
        .all(|part| match left.iter().position(|other| eq(part, other)) {
            Some(at) => {
                left.remove(at);
                true
            }
            None => false,
        })
}

fn has_z(g: &Geom) -> bool {
    fn deep(b: &Body) -> bool {
        match b {
            Body::Point(p) => p.len() > 2,
            Body::Line(l) | Body::MultiPoint(l) => l.iter().any(|p| p.len() > 2),
            Body::Polygon(r) | Body::MultiLine(r) => r.iter().flatten().any(|p| p.len() > 2),
            Body::MultiPolygon(m) => m.iter().flatten().flatten().any(|p| p.len() > 2),
            Body::Collection(c) => c.iter().any(has_z),
        }
    }
    g.z || g.body.as_ref().is_some_and(deep)
}

fn body_equal(a: &Body, b: &Body, o: &GeomOpts) -> bool {
    match (a, b) {
        (Body::Point(x), Body::Point(y)) => coords_equal(x, y, o.tolerance),
        (Body::Line(x), Body::Line(y)) => line_equal(x, y, o),
        (Body::Polygon(x), Body::Polygon(y)) => polygon_equal(x, y, o),
        (Body::MultiPoint(x), Body::MultiPoint(y)) => multi_equal(x, y, o, |p, q| coords_equal(p, q, o.tolerance)),
        (Body::MultiLine(x), Body::MultiLine(y)) => multi_equal(x, y, o, |p, q| line_equal(p, q, o)),
        (Body::MultiPolygon(x), Body::MultiPolygon(y)) => multi_equal(x, y, o, |p, q| polygon_equal(p, q, o)),
        (Body::Collection(x), Body::Collection(y)) => multi_equal(x, y, o, |p, q| exact_diff(p, q, o).is_none()),
        _ => false,
    }
}

fn exact_diff(a: &Geom, b: &Geom, o: &GeomOpts) -> Option<String> {
    if a.kind != b.kind {
        return Some(format!("type {} ≠ {}", a.kind, b.kind));
    }
    match (&a.body, &b.body) {
        (None, None) => return None,
        (None, _) | (_, None) => return Some("one is empty".into()),
        _ => {}
    }
    if has_z(a) != has_z(b) {
        let d = |g| if has_z(g) { "XYZ" } else { "XY" };
        return Some(format!("dimensions {} ≠ {}", d(a), d(b)));
    }
    (!body_equal(a.body.as_ref()?, b.body.as_ref()?, o)).then(|| "coordinates differ".into())
}

/// Polygonal geometry for the topology mode (XY only; Z was already compared).
fn polygonal(g: &Geom) -> Result<MultiPolygon<f64>, String> {
    let ring = |r: &Vec<Vec<f64>>| geo::LineString::from(r.iter().map(|p| (p[0], p[1])).collect::<Vec<_>>());
    let poly = |p: &Vec<Vec<Vec<f64>>>| geo::Polygon::new(ring(&p[0]), p[1..].iter().map(ring).collect());
    match &g.body {
        Some(Body::Polygon(p)) => Ok(MultiPolygon(vec![poly(p)])),
        Some(Body::MultiPolygon(m)) => Ok(MultiPolygon(m.iter().map(poly).collect())),
        // ponytail: topology mode for points/lines is not ported yet (no gate-1 case uses it); port with the first one that does.
        _ => Err(format!("topology comparison of {} is not ported yet", g.kind)),
    }
}

pub fn compare_geometry(actual: Option<&str>, expected: Option<&str>, o: &GeomOpts) -> Option<String> {
    let (a_txt, b_txt) = match (actual, expected) {
        (Some(a), Some(b)) => (a, b),
        (None, None) => return None,
        _ => return Some(format!("{actual:?} ≠ {expected:?}")),
    };
    let (a, b) = match (parse(a_txt), parse(b_txt)) {
        (Ok(a), Ok(b)) => (a, b),
        (Err(e), _) | (_, Err(e)) => return Some(e),
    };
    if o.mode == "exact" {
        return exact_diff(&a, &b, o).map(|d| format!("{d}: {a_txt} vs {b_txt}"));
    }
    if a.kind != b.kind {
        return Some(format!("type {} ≠ {}: {a_txt} vs {b_txt}", a.kind, b.kind));
    }
    match (&a.body, &b.body) {
        (None, None) => return None,
        (None, _) | (_, None) => return Some(format!("one is empty: {a_txt} vs {b_txt}")),
        _ => {}
    }
    if has_z(&a) != has_z(&b) {
        return Some(format!("dimensions differ: {a_txt} vs {b_txt}"));
    }
    let (ga, gb) = match (polygonal(&a), polygonal(&b)) {
        (Ok(x), Ok(y)) => (x, y),
        (Err(e), _) | (_, Err(e)) => return Some(e),
    };
    if ga.is_valid() != gb.is_valid() {
        return Some(format!("validity differs: {a_txt} vs {b_txt}"));
    }
    let reference = gb.unsigned_area().max(1e-30);
    let sym = ga.xor(&gb).unsigned_area();
    if sym > o.area_tolerance * reference {
        return Some(format!(
            "shapes differ (symmetric difference {sym} > {} × {reference}): {a_txt} vs {b_txt}",
            o.area_tolerance
        ));
    }
    let hausdorff = Geometry::from(ga).hausdorff_distance(&Geometry::from(gb));
    (hausdorff > o.tolerance).then(|| format!("Hausdorff distance {hausdorff} > {}: {a_txt} vs {b_txt}", o.tolerance))
}

fn value_equal(a: &Value, b: &Value, kind: &str, o: &GeomOpts) -> bool {
    if a.is_null() || b.is_null() {
        return a.is_null() && b.is_null();
    }
    if kind == "GEOMETRY" {
        return compare_geometry(a.as_str(), b.as_str(), o).is_none();
    }
    if let (Some(x), Some(y)) = (a.as_f64(), b.as_f64()) {
        return x == y || (x - y).abs() <= 1e-9 * 1f64.max(x.abs()).max(y.abs());
    }
    a == b
}

pub struct Table {
    pub columns: Vec<(String, String)>,
    pub rows: Vec<Vec<Value>>,
}

impl Table {
    pub fn from_json(v: &Value) -> Table {
        let columns = v["columns"]
            .as_array()
            .map(|cs| {
                cs.iter()
                    .map(|c| {
                        (
                            c["name"].as_str().unwrap_or("").into(),
                            c["type"].as_str().unwrap_or("").into(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let rows = v["rows"]
            .as_array()
            .map(|rs| rs.iter().map(|r| r.as_array().cloned().unwrap_or_default()).collect())
            .unwrap_or_default();
        Table { columns, rows }
    }
}

pub fn compare_table(actual: &Table, expected: &Table, ordered: bool, o: &GeomOpts) -> Vec<String> {
    let names = |t: &Table| {
        t.columns
            .iter()
            .map(|(n, k)| format!("{n} {k}"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    if names(actual) != names(expected) {
        return vec![format!(
            "columns differ:\n    actual:   {}\n    expected: {}",
            names(actual),
            names(expected)
        )];
    }
    let kinds: Vec<&str> = expected.columns.iter().map(|(_, k)| k.as_str()).collect();
    let row_equal = |x: &Vec<Value>, y: &Vec<Value>| {
        x.len() == y.len() && x.iter().zip(y).zip(&kinds).all(|((a, b), k)| value_equal(a, b, k, o))
    };
    let mut problems = Vec::new();
    if actual.rows.len() != expected.rows.len() {
        problems.push(format!("{} rows, expected {}", actual.rows.len(), expected.rows.len()));
    }
    if ordered {
        for (k, row) in expected.rows.iter().enumerate() {
            if let Some(a) = actual.rows.get(k).filter(|a| !row_equal(a, row)) {
                problems.push(format!(
                    "row {k}: {} ≠ {}",
                    Value::from(a.clone()),
                    Value::from(row.clone())
                ));
            }
        }
        return problems;
    }
    let mut left: Vec<&Vec<Value>> = actual.rows.iter().collect();
    for row in &expected.rows {
        match left.iter().position(|c| row_equal(c, row)) {
            Some(at) => {
                left.remove(at);
            }
            None => problems.push(format!("missing row {}", Value::from(row.clone()))),
        }
    }
    problems.extend(
        left.into_iter()
            .map(|r| format!("unexpected row {}", Value::from(r.clone()))),
    );
    problems
}
