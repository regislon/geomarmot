//! The SQL VertexCreator compiles to (`transformers/vertex-creator/sql.js`).
//!
//! Each feature's vertices are unpacked into a list of {x, y, z} structs, the new vertex is
//! appended, inserted or swapped in with list slicing, and the result is written back out as WKT
//! (this build's ST_MakeLine is 2D only). Every intermediate is a `_vc_` column, dropped at the end.

use crate::valuespec::value_sql;
use crate::{Column, Ports, Result, find_geometry_column, geometry_expression, js_number, qid};
use serde_json::Value;

/// The attribute that carries a rejected feature's reason.
const REJECTION_COLUMN: &str = "rejection_code";

/// A coordinate or index parameter as SQL, or None when it is not filled in.
fn param_sql(spec: &Value, kind: &str) -> Option<String> {
    let value_kind = spec.get("kind").and_then(Value::as_str).unwrap_or("Value");
    let empty = match spec.get("value") {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.trim().is_empty(),
        Some(_) => false,
    };
    if (value_kind.is_empty() || value_kind == "Value") && empty {
        return None;
    }
    value_sql(spec).map(|sql| format!("TRY_CAST({sql} AS {kind})"))
}

fn vertex_at(geom: &str, i: &str) -> String {
    let p = format!("ST_PointN({geom}, ({i})::INTEGER)");
    format!("{{'x': ST_X({p}), 'y': ST_Y({p}), 'z': CASE WHEN ST_HasZ({geom}) THEN ST_Z({p}) END}}")
}

/// The feature's vertices; a polygon's exterior ring without its closing vertex.
fn vertex_list() -> String {
    let ring = "ST_ExteriorRing(_vc_g)";
    format!(
        "CASE _vc_t WHEN 'POINT' THEN [{{'x': ST_X(_vc_g), 'y': ST_Y(_vc_g), 'z': CASE WHEN ST_HasZ(_vc_g) THEN ST_Z(_vc_g) END}}] \
         WHEN 'LINESTRING' THEN list_transform(range(1, ST_NPoints(_vc_g) + 1), i -> {}) \
         WHEN 'POLYGON' THEN list_transform(range(1, ST_NPoints({ring})), i -> {}) \
         ELSE []::STRUCT(x DOUBLE, y DOUBLE, z DOUBLE)[] END",
        vertex_at("_vc_g", "i"),
        vertex_at(ring, "i")
    )
}

/// Why a feature goes to <Rejected>, or NULL when it can be handled.
fn rejection(mode: &str) -> String {
    let index = if mode.ends_with("at Index") {
        "WHEN _vc_i IS NULL THEN 'MISSING_INDEX' "
    } else {
        ""
    };
    let missing = format!("CASE WHEN _vc_x IS NULL OR _vc_y IS NULL THEN 'MISSING_COORDINATE' {index}");
    match mode {
        "Replace with Point" => format!("{missing}END"),
        "Add Point" => {
            format!("{missing}WHEN _vc_t NOT IN ('NULL', 'POINT', 'LINESTRING') THEN 'UNSUPPORTED_GEOMETRY_TYPE' END")
        }
        _ => format!(
            "{missing}WHEN _vc_t NOT IN ('NULL', 'POINT', 'LINESTRING', 'POLYGON') THEN 'UNSUPPORTED_GEOMETRY_TYPE' \
             WHEN _vc_t = 'POLYGON' AND ST_NInteriorRings(_vc_g) > 0 THEN 'POLYGON_WITH_HOLES' END"
        ),
    }
}

/// Where the new vertex lands, 1-based: 0 first, -1 last, out of range clamped.
fn position(mode: &str) -> &'static str {
    if mode == "Insert Point at Index" {
        "CASE WHEN _vc_i >= 0 THEN least(_vc_i, _vc_n) ELSE greatest(0, _vc_n + 1 + _vc_i) END + 1"
    } else {
        "CASE WHEN _vc_i >= 0 THEN least(_vc_i, _vc_n - 1) ELSE greatest(0, _vc_n + _vc_i) END + 1"
    }
}

/// The new vertex's Z when the input is 3D and no Z Value was given.
fn computed_z(mode: &str, conflict: &str, custom: f64) -> String {
    let add = mode == "Add Point";
    let or_else = |fallback: &str| {
        if add {
            format!(
                "CASE WHEN _vc_n > 0 AND _vc_v[1].x = _vc_x AND _vc_v[1].y = _vc_y THEN _vc_v[1].z \
                 WHEN _vc_n > 0 AND _vc_v[_vc_n].x = _vc_x AND _vc_v[_vc_n].y = _vc_y THEN _vc_v[_vc_n].z \
                 ELSE {fallback} END"
            )
        } else {
            fallback.to_string()
        }
    };
    if conflict == "Custom Value" {
        return or_else(&custom.to_string());
    }
    if conflict != "Compute" {
        return or_else("NULL");
    }
    if add {
        return or_else("_vc_v[_vc_n].z");
    }
    let (before, after) = if mode == "Insert Point at Index" {
        ("_vc_v[_vc_p - 1]", "_vc_v[_vc_p]")
    } else {
        ("_vc_v[_vc_p - 1]", "_vc_v[_vc_p + 1]")
    };
    let dist = |a: &str| format!("sqrt(power({a}.x - _vc_x, 2) + power({a}.y - _vc_y, 2))");
    let (db, da) = (dist(before), dist(after));
    or_else(&format!(
        "CASE WHEN {before} IS NULL AND {after} IS NULL THEN _vc_v[_vc_p].z \
         WHEN {after} IS NULL THEN {before}.z WHEN {before} IS NULL THEN {after}.z \
         WHEN {db} + {da} = 0 THEN ({before}.z + {after}.z) / 2 \
         ELSE {before}.z + ({after}.z - {before}.z) * {db} / ({db} + {da}) END"
    ))
}

/// The vertex list after the edit.
fn edited_list(mode: &str, ignore_duplicates: bool) -> String {
    let vertex = "{'x': _vc_x, 'y': _vc_y, 'z': _vc_nz}";
    match mode {
        "Replace with Point" => format!("[{vertex}]"),
        "Add Point" if ignore_duplicates => format!(
            "CASE WHEN _vc_n > 0 AND _vc_v[_vc_n].x = _vc_x AND _vc_v[_vc_n].y = _vc_y THEN _vc_v \
             ELSE list_append(_vc_v, {vertex}) END"
        ),
        "Add Point" => format!("list_append(_vc_v, {vertex})"),
        "Insert Point at Index" => {
            format!("list_concat(list_concat(_vc_v[1:_vc_p - 1], [{vertex}]), _vc_v[_vc_p:])")
        }
        _ => format!(
            "CASE WHEN _vc_n = 0 THEN [{vertex}] \
             ELSE list_concat(list_concat(_vc_v[1:_vc_p - 1], [{vertex}]), _vc_v[_vc_p + 1:]) END"
        ),
    }
}

/// The edited vertices as a geometry: a point, a re-closed polygon, a line closing into a
/// polygon when asked, or a line.
fn rebuilt_geometry(closed_as_polygon: bool) -> String {
    let coord = "p -> p.x::VARCHAR || ' ' || p.y::VARCHAR || \
                 CASE WHEN _vc_3d THEN ' ' || coalesce(p.z, _vc_fill, 0)::VARCHAR ELSE '' END";
    let coords = format!("array_to_string(list_transform(_vc_e, {coord}), ', ')");
    let first = format!("list_transform([_vc_e[1]], {coord})[1]");
    let dims = "CASE WHEN _vc_3d THEN ' Z' ELSE '' END";
    let closed = "(len(_vc_e) >= 4 AND _vc_e[1].x = _vc_e[-1].x AND _vc_e[1].y = _vc_e[-1].y)";
    let polygon = if closed_as_polygon {
        format!("WHEN {closed} THEN 'POLYGON' || {dims} || ' ((' || {coords} || '))' ")
    } else {
        String::new()
    };
    format!(
        "ST_GeomFromText(CASE WHEN len(_vc_e) = 1 THEN 'POINT' || {dims} || ' (' || {coords} || ')' \
         WHEN _vc_t = 'POLYGON' THEN 'POLYGON' || {dims} || ' ((' || {coords} || ', ' || {first} || '))' \
         {polygon}ELSE 'LINESTRING' || {dims} || ' (' || {coords} || ')' END)"
    )
}

/// The two port queries for a VertexCreator node.
pub fn vertex_creator_sql(params: &Value, input: &str, columns: &[Column]) -> Result<Ports> {
    let s = |k: &str, default: &'static str| {
        params
            .get(k)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .unwrap_or(default)
            .to_string()
    };
    let (mode, conflict) = (s("mode", "Add Point"), s("zConflict", "Compute"));
    let (x, y) = match (param_sql(&params["x"], "DOUBLE"), param_sql(&params["y"], "DOUBLE")) {
        (Some(x), Some(y)) => (x, y),
        _ => return Err("Set an X Value and a Y Value.".into()),
    };
    let z = param_sql(&params["z"], "DOUBLE").unwrap_or_else(|| "NULL::DOUBLE".into());
    let by_index = mode.ends_with("at Index");
    let index = if by_index {
        param_sql(&params["index"], "BIGINT").ok_or("Set the Index to insert at or replace.")?
    } else {
        "NULL::BIGINT".into()
    };
    let custom = js_number(params.get("zCustom").unwrap_or(&Value::from(0)));
    if conflict == "Custom Value" && custom.is_none() {
        return Err("The custom Z value must be a number.".into());
    }
    let custom = custom.unwrap_or(f64::NAN);

    let geometry = find_geometry_column(columns);
    let column = qid(geometry.as_ref().map_or("geometry", |g| g.name.as_str()));
    let source = geometry.as_ref().map_or("NULL::GEOMETRY".into(), geometry_expression);
    let names: Vec<&str> = columns.iter().map(|c| c.name.as_str()).collect();
    let removed: Vec<String> = if params.get("removeAttributes").and_then(Value::as_str) == Some("Yes") {
        ["x", "y", "z"]
            .iter()
            .filter(|k| params[**k]["kind"] == "Attribute")
            .filter_map(|k| params[*k]["column"].as_str())
            .filter(|c| !c.is_empty() && names.contains(c))
            .map(String::from)
            .collect()
    } else {
        vec![]
    };

    let stage1 = format!(
        "SELECT *, {source} AS _vc_g, CASE WHEN {source} IS NULL OR ST_IsEmpty({source}) THEN 'NULL' \
         ELSE ST_GeometryType({source})::VARCHAR END AS _vc_t, {x} AS _vc_x, {y} AS _vc_y, {z} AS _vc_z, \
         {index} AS _vc_i FROM {input}"
    );
    let stage2 = format!(
        "SELECT *, {} AS _vc_v, {} AS _vc_r FROM ({stage1})",
        vertex_list(),
        rejection(&mode)
    );
    let place = if by_index {
        position(&mode).replace("_vc_n", "len(_vc_v)")
    } else {
        "NULL::BIGINT".into()
    };
    let stage3 = format!("SELECT *, len(_vc_v) AS _vc_n, {place} AS _vc_p FROM ({stage2})");
    let (in3d, given) = ("coalesce(ST_HasZ(_vc_g), false)", "_vc_z IS NOT NULL");
    let replacing = mode == "Replace with Point";
    let out3d = if replacing {
        given.to_string()
    } else if conflict == "None (Drop Values)" {
        format!("({in3d} AND {given})")
    } else {
        format!("({in3d} OR {given})")
    };
    let new_z = if replacing {
        "_vc_z".to_string()
    } else {
        let otherwise = if conflict == "Custom Value" {
            custom.to_string()
        } else {
            "NULL".into()
        };
        format!(
            "CASE WHEN {given} THEN _vc_z WHEN {in3d} THEN {} ELSE {otherwise} END",
            computed_z(&mode, &conflict, custom)
        )
    };
    let fill = match conflict.as_str() {
        "Custom Value" => custom.to_string(),
        "Compute" => "_vc_z".into(),
        _ => "NULL".into(),
    };
    let stage4 = format!("SELECT *, {new_z} AS _vc_nz, {out3d} AS _vc_3d, {fill}::DOUBLE AS _vc_fill FROM ({stage3})");
    let edited = edited_list(&mode, s("ignoreDuplicates", "Yes") == "Yes");
    let stage5 = format!("SELECT *, CASE WHEN _vc_r IS NULL THEN {edited} END AS _vc_e FROM ({stage4})");

    let built = rebuilt_geometry(s("closedLines", "Create Polygon") == "Create Polygon");
    let dropped = [
        "_vc_g", "_vc_t", "_vc_x", "_vc_y", "_vc_z", "_vc_i", "_vc_v", "_vc_n", "_vc_p", "_vc_r", "_vc_nz", "_vc_3d",
        "_vc_fill", "_vc_e",
    ];
    let exclude = |extra: &[String]| {
        let mut all: Vec<String> = dropped.iter().map(|d| d.to_string()).collect();
        for e in extra {
            if !all.contains(e) {
                all.push(e.clone());
            }
        }
        all.iter().map(|n| qid(n)).collect::<Vec<_>>().join(", ")
    };
    let mut out_extra = removed;
    out_extra.extend(geometry.map(|g| g.name));
    Ok(Ports::from([
        (
            "output".into(),
            format!(
                "SELECT * EXCLUDE ({}), {built} AS {column} FROM ({stage5}) WHERE _vc_r IS NULL",
                exclude(&out_extra)
            ),
        ),
        (
            "rejected".into(),
            format!(
                "SELECT * EXCLUDE ({}), _vc_r AS {} FROM ({stage5}) WHERE _vc_r IS NOT NULL",
                exclude(&[]),
                qid(REJECTION_COLUMN)
            ),
        ),
    ]))
}
