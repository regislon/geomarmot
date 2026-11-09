//! The overlay core against `tests/fixtures/geos-overlay-parity.json`, with the rules of
//! `tests/harness/geos-parity.js`: face count, no ambiguous face, the same member sets,
//! and per member set a symmetric difference of at most 1e-12.

use geomarmot_kernels::overlay::{TaskResult, geo_core, overlay_parts};
use geos::{Geom, Geometry};
use serde_json::Value;

const MAX_SYMDIFF_AREA: f64 = 1e-12;

#[test]
fn geos_core_matches_the_parity_fixture() {
    check(overlay_parts);
}

/// Spike gate 2 finding (2026-11-09): fails. `geo`'s boolean ops snap to a fixed-precision grid, so
/// faces drift by ~1e-8 (limit 1e-12), extra sliver faces appear, and the donut case gives 6 faces, not 8.
#[test]
#[ignore = "the geo core fails overlay parity; GEOS is the overlay kernel (see rust/README.md)"]
fn geo_core_matches_the_parity_fixture() {
    check(geo_core::overlay_parts);
}

fn check(core: fn(&[&[u8]], f64) -> Result<TaskResult, String>) {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../tests/fixtures/geos-overlay-parity.json"
    );
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let tau = doc["tau"].as_f64().unwrap();
    let mut problems = Vec::new();
    for (name, case) in doc["cases"].as_object().unwrap() {
        let wkb: Vec<Vec<u8>> = case["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| Geometry::new_from_wkt(w.as_str().unwrap()).unwrap().to_wkb().unwrap())
            .collect();
        let refs: Vec<&[u8]> = wkb.iter().map(Vec::as_slice).collect();
        let r = core(&refs, tau).unwrap();
        let want = case["faceCount"].as_u64().unwrap() as usize;
        if r.faces.len() != want {
            problems.push(format!("{name}: {} faces, expected {want}", r.faces.len()));
        }
        if r.ambiguous.iter().any(|a| *a) {
            problems.push(format!("{name}: ambiguous faces"));
        }
        let mut groups: std::collections::BTreeMap<String, Vec<Geometry>> = Default::default();
        for (f, face) in r.faces.iter().enumerate() {
            let mut m = r.members[f].clone();
            m.sort();
            if !m.is_empty() {
                let key = m.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",");
                groups
                    .entry(key)
                    .or_default()
                    .push(Geometry::new_from_wkb(face).unwrap());
            }
        }
        let expected: Vec<(String, String)> = case["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| {
                let key = g["members"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|m| m.to_string())
                    .collect::<Vec<_>>()
                    .join(",");
                (key, g["wkt"].as_str().unwrap().to_string())
            })
            .collect();
        for key in groups.keys() {
            if !expected.iter().any(|(k, _)| k == key) {
                problems.push(format!("{name}: unexpected member set [{key}]"));
            }
        }
        for (key, wkt) in &expected {
            let Some(faces) = groups.get(key) else {
                problems.push(format!("{name}: missing member set [{key}]"));
                continue;
            };
            let mut union = Geom::clone(&faces[0]).unwrap();
            for f in &faces[1..] {
                union = union.union(f).unwrap();
            }
            let area = union
                .sym_difference(&Geometry::new_from_wkt(wkt).unwrap())
                .unwrap()
                .area()
                .unwrap();
            if area.is_nan() || area > MAX_SYMDIFF_AREA {
                problems.push(format!("{name}: member set [{key}] symmetric difference {area}"));
            }
        }
    }
    assert!(problems.is_empty(), "\n{}", problems.join("\n"));
}
