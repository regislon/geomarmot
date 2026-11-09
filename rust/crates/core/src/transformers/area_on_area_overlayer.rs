//! Port of `transformers/area-on-area-overlayer/index.js`.

use crate::{
    Ctx, GeometryColumn, OverlayRequest, Ports, Result, Step, Transformer, find_geometry_column, geometry_expression,
    qid, qlit, thousands,
};
use serde_json::Value;

/// `MAX_OVERLAY_FEATURES` (app/src/core/limits.js).
pub const MAX_OVERLAY_FEATURES: u64 = 200_000;
const FID: &str = "_pv_fid";
const OVERLAP_COUNT_COLUMN: &str = "_overlaps";
const REJECTION_COLUMN: &str = "rejection_code";
const DROP: &str = "Drop and report";
const FAIL: &str = "Fail";
const REPAIR: &str = "Repair";

pub struct AreaOnAreaOverlayer;

struct Tables {
    source: String,
    rejected_rows: String,
    work: String,
    faces: String,
    memberships: String,
    ambiguous: String,
}

fn tables(ctx: &Ctx) -> Tables {
    Tables {
        source: ctx.table_name("source"),
        rejected_rows: ctx.table_name("rejectedrows"),
        work: ctx.table_name("work"),
        faces: ctx.table_name("faces"),
        memberships: ctx.table_name("memberships"),
        ambiguous: ctx.table_name("ambiguous"),
    }
}

fn geometry(ctx: &Ctx) -> Result<GeometryColumn> {
    find_geometry_column(ctx.schema("input")).ok_or_else(|| "This input has no geometry to overlay.".into())
}

/// Trimmed text of an attribute, NULL when missing or blank.
fn id_text(column: &str) -> String {
    format!("NULLIF(TRIM(CAST({} AS VARCHAR)), '')", qid(column))
}

fn rejected_rows_sql(t: &Tables, ctx: &Ctx, g: &GeometryColumn) -> String {
    let geom = geometry_expression(g);
    let mut reasons = vec![
        format!("WHEN {geom} IS NULL OR ST_IsEmpty({geom}) THEN 'no_geometry'"),
        format!(
            "WHEN NOT list_contains(list_transform(ST_Dump({geom}), d -> ST_GeometryType(d.geom)::VARCHAR), 'POLYGON') \
             THEN 'no_polygon'"
        ),
    ];
    let id = ctx.str("idAttribute");
    if !id.is_empty() {
        let layer = Some(ctx.str("layerAttribute"))
            .filter(|l| !l.is_empty())
            .map(id_text)
            .unwrap_or("NULL".into());
        reasons.push(format!("WHEN {} IS NULL THEN 'missing_id'", id_text(id)));
        reasons.push(format!(
            "WHEN count(*) OVER (PARTITION BY {layer}, {}) > 1 THEN 'duplicate_id'",
            id_text(id)
        ));
    }
    if ctx.str("invalid") != REPAIR {
        reasons.push(format!("WHEN NOT ST_IsValid({geom}) THEN 'invalid_geometry'"));
    }
    format!(
        "CREATE OR REPLACE TABLE {} AS SELECT * FROM (SELECT *, CASE {} END AS {r} FROM {}) WHERE {r} IS NOT NULL",
        t.rejected_rows,
        reasons.join(" "),
        t.source,
        r = qid(REJECTION_COLUMN)
    )
}

fn work_sql(t: &Tables, ctx: &Ctx, g: &GeometryColumn) -> String {
    let geom = geometry_expression(g);
    let value = if ctx.str("invalid") == REPAIR {
        format!("CASE WHEN ST_IsValid({geom}) THEN {geom} ELSE ST_MakeValid({geom}) END")
    } else {
        geom
    };
    let fid = qid(FID);
    format!(
        "CREATE OR REPLACE TABLE {} AS SELECT {fid}, {value} AS {} FROM {} WHERE {fid} NOT IN (SELECT {fid} FROM {})",
        t.work,
        qid(&g.name),
        t.source,
        t.rejected_rows
    )
}

impl Transformer for AreaOnAreaOverlayer {
    fn id(&self) -> &'static str {
        "AreaOnAreaOverlayer"
    }

    fn outputs(&self, _params: &Value) -> Vec<String> {
        vec!["output".into(), "memberships".into(), "rejected".into()]
    }

    fn needs_schema(&self) -> bool {
        true
    }

    fn needs_lonlat(&self) -> bool {
        true
    }

    fn prepare(&self, ctx: &Ctx) -> Result<Vec<Step>> {
        let g = geometry(ctx)?;
        let t = tables(ctx);
        let fid = qid(FID);
        let fail = ctx.str("ambiguous") == FAIL;
        Ok(vec![
            Step::Exec(format!(
                "CREATE OR REPLACE TABLE {} AS SELECT row_number() OVER () AS {fid}, * FROM {}",
                t.source,
                ctx.input("input")
            )),
            Step::Cap {
                count_sql: format!("SELECT count(*) FROM {}", t.source),
                cap: MAX_OVERLAY_FEATURES,
                message: Box::new(|n| {
                    format!(
                        "{} features is past the {} ceiling for an overlay. Filter or dissolve upstream first.",
                        thousands(n),
                        thousands(MAX_OVERLAY_FEATURES)
                    )
                }),
            },
            Step::Exec(rejected_rows_sql(&t, ctx, &g)),
            Step::Exec(work_sql(&t, ctx, &g)),
            Step::Overlay {
                request: OverlayRequest {
                    source: t.work.clone(),
                    fid: fid.clone(),
                    geometry: qid(&g.name),
                    faces: t.faces.clone(),
                    memberships: t.memberships.clone(),
                    ambiguous: t.ambiguous.clone(),
                },
                fail_if_ambiguous: fail.then(|| -> Box<dyn Fn(usize) -> String + Send> {
                    Box::new(|n| {
                        format!(
                            "{} face(s) are too thin to tell which polygons cover them. \
                             Choose \"{DROP}\" to list them in Rejected instead.",
                            thousands(n as u64)
                        )
                    })
                }),
            },
        ])
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let g = geometry(ctx)?;
        let t = tables(ctx);
        let fid = qid(FID);
        let separator = ctx.params.get("separator").and_then(Value::as_str).unwrap_or(";");
        let count = qid(Some(ctx.str("countAttribute"))
            .filter(|c| !c.is_empty())
            .unwrap_or(OVERLAP_COUNT_COLUMN));
        let mut columns = vec![
            format!("f.geometry AS {}", qid(&g.name)),
            format!("count(*) AS {count}"),
        ];
        for name in ctx.strings("accumulate").iter().filter(|n| **n != g.name) {
            let c = qid(name);
            columns.push(format!(
                "string_agg(DISTINCT s.{c}, {} ORDER BY s.{c}) AS {c}",
                qlit(separator)
            ));
        }
        let id = ctx.str("idAttribute");
        let layer = ctx.str("layerAttribute");
        if !id.is_empty() {
            columns.push("f.face_id".into());
        }
        let output = format!(
            "SELECT {} FROM {} f JOIN {} m USING (face_id) JOIN {} s ON s.{fid} = m.fid GROUP BY f.face_id, f.geometry",
            columns.join(", "),
            t.faces,
            t.memberships,
            t.source
        );
        let text = |c: &str| {
            if c.is_empty() {
                "CAST(NULL AS VARCHAR)".to_string()
            } else {
                format!("CAST(s.{} AS VARCHAR)", qid(c))
            }
        };
        let memberships = format!(
            "SELECT m.face_id, {} AS layer, {} AS feature_id FROM {} m JOIN {} s ON s.{fid} = m.fid{}",
            text(layer),
            text(id),
            t.memberships,
            t.source,
            if id.is_empty() { " WHERE false" } else { "" }
        );
        let rejected = format!(
            "SELECT * EXCLUDE ({fid}) FROM {} UNION ALL BY NAME SELECT geometry AS {}, 'ambiguous_face' AS {} FROM {}",
            t.rejected_rows,
            qid(&g.name),
            qid(REJECTION_COLUMN),
            t.ambiguous
        );
        Ok(Ports::from([
            ("output".into(), output),
            ("memberships".into(), memberships),
            ("rejected".into(), rejected),
        ]))
    }
}
