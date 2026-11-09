//! The shared shape of per-feature geometry tools (`jsGeometryTool` in the JavaScript kit):
//! number the rows, run the kernel on each non-NULL geometry, join the shapes back by number.

use crate::{Ctx, KernelRequest, Ports, Result, Step, find_geometry_column, geometry_expression, qid};

const FID: &str = "_pv_fid";

pub fn prepare(ctx: &Ctx, id: &str, op: &str) -> Result<Vec<Step>> {
    let g = find_geometry_column(ctx.schema("input")).ok_or_else(|| format!("{id} needs a geometry column."))?;
    let (source, shapes, fid) = (ctx.table_name("src"), ctx.table_name("shape"), qid(FID));
    Ok(vec![
        Step::Exec(format!(
            "CREATE OR REPLACE TABLE {source} AS SELECT row_number() OVER () AS {fid}, * FROM {}",
            ctx.input("input")
        )),
        Step::Kernel(KernelRequest {
            op: op.into(),
            input_sql: format!(
                "SELECT {fid}::BIGINT, ST_AsWKB({}) FROM {source} WHERE {} IS NOT NULL",
                geometry_expression(&g),
                qid(&g.name)
            ),
            output: shapes,
        }),
    ])
}

pub fn sql(ctx: &Ctx, id: &str) -> Result<Ports> {
    let g = find_geometry_column(ctx.schema("input")).ok_or_else(|| format!("{id} needs a geometry column."))?;
    let column = qid(&g.name);
    Ok(Ports::from([(
        "output".into(),
        format!(
            "SELECT s.* EXCLUDE ({fid}, {column}), g.geometry AS {column} FROM {} s LEFT JOIN {} g ON s.{fid} = g.key",
            ctx.table_name("src"),
            qid(&ctx.table_name("shape")),
            fid = qid(FID),
        ),
    )]))
}
