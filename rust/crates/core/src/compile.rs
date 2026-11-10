//! Compiling one node into views (spike scope: no graph, generations or leases yet).
//!
//! Mirrors `app/src/core/graph/compiler.js` + `node.js` for a single node:
//! resolve inputs and the incoming CRS, DESCRIBE inputs when needed, run
//! sql → crs → check, then create one view per output port in one transaction.

use std::collections::BTreeMap;

use crate::{Ctx, LONLAT, OverlayRequest, Result, SqlEngine, Transformer, is_lonlat, qid, sqlguard};
use serde_json::Value;

pub struct NodeOutput {
    /// Port id → view name.
    pub views: BTreeMap<String, String>,
    pub crs: String,
}

/// A `check` hook's query, and how to word its failure.
pub struct Probe {
    pub sql: String,
    pub error: Box<dyn Fn(&str) -> String + Send>,
}

/// One step of a `prepare` hook.
pub enum Step {
    Exec(String),
    /// Fail with `message(n)` when `count_sql` returns more than `cap` rows.
    Cap {
        count_sql: String,
        cap: u64,
        message: Box<dyn Fn(u64) -> String + Send>,
    },
    /// Run a per-feature kernel (geomarmot_kernels::features).
    Kernel(crate::KernelRequest),
    /// Run a raster kernel next to the rasters.
    Raster(crate::RasterRequest),
    /// Run the overlay kernel; with `fail_if_ambiguous`, any ambiguous face is an error.
    Overlay {
        request: OverlayRequest,
        fail_if_ambiguous: Option<Box<dyn Fn(usize) -> String + Send>>,
    },
}

async fn run_step(engine: &impl SqlEngine, step: Step) -> Result<()> {
    match step {
        Step::Exec(sql) => engine.exec(&sql).await,
        Step::Cap {
            count_sql,
            cap,
            message,
        } => {
            let rows = engine.query(&count_sql).await?;
            let n = rows.first().and_then(|r| r[0].as_u64()).unwrap_or(0);
            if n > cap { Err(message(n)) } else { Ok(()) }
        }
        Step::Kernel(request) => engine.kernel(&request).await,
        Step::Raster(request) => engine.raster(&request).await,
        Step::Overlay {
            request,
            fail_if_ambiguous,
        } => {
            let stats = engine.overlay(&request).await?;
            match fail_if_ambiguous {
                Some(message) if stats.ambiguous > 0 => Err(message(stats.ambiguous)),
                _ => Ok(()),
            }
        }
    }
}

/// `inputs`: port → (relation, CRS). `prefix` names the node's views.
pub async fn compile_node(
    engine: &impl SqlEngine,
    t: &dyn Transformer,
    params: &Value,
    inputs: &BTreeMap<String, (String, String)>,
    prefix: &str,
) -> Result<NodeOutput> {
    compile_node_from(engine, t, params, inputs, prefix, None).await
}

/// As `compile_node`, fed by a Reader of the file `source` (H3 tiles are named after their cell).
// ponytail: the graph does not pass the Reader's file name yet; only the fixture harness does.
pub async fn compile_node_from(
    engine: &impl SqlEngine,
    t: &dyn Transformer,
    params: &Value,
    inputs: &BTreeMap<String, (String, String)>,
    prefix: &str,
    source: Option<String>,
) -> Result<NodeOutput> {
    // Step 0: the SQL guard, before any hook or query (`guardNode`).
    sqlguard::guard_node(engine, t.params(), params)
        .await
        .map_err(|r| r.message)?;
    let mut relations = BTreeMap::new();
    let mut crs_seen = Vec::<String>::new();
    for port in t.inputs() {
        let (relation, crs) = inputs
            .get(*port)
            .ok_or_else(|| format!("\"{port}\" is not connected."))?;
        relations.insert(port.to_string(), relation.clone());
        if !crs_seen.contains(crs) {
            crs_seen.push(crs.clone());
        }
    }
    if crs_seen.len() > 1 {
        return Err(format!(
            "Its inputs are in different coordinate systems ({}).",
            crs_seen.join(", ")
        ));
    }
    let incoming_crs = crs_seen.pop().unwrap_or_else(|| LONLAT.to_string());
    if t.needs_lonlat() && !is_lonlat(&incoming_crs) {
        return Err(format!(
            "{} works in longitude/latitude, but its input is in {incoming_crs}. Reproject back to {LONLAT} before it.",
            t.id()
        ));
    }
    let mut schemas = BTreeMap::new();
    if t.needs_schema() {
        for (port, relation) in &relations {
            schemas.insert(port.clone(), engine.describe(relation).await?);
        }
    }
    let ctx = Ctx {
        node_type: t.id().to_string(),
        params: params.clone(),
        inputs: relations,
        schemas,
        incoming_crs,
        row_count: None,
        prefix: prefix.to_string(),
        source,
    };
    let mut ctx = ctx;
    if t.needs_row_count()
        && let Some(first) = t.inputs().first().and_then(|p| ctx.inputs.get(*p))
    {
        let rows = engine.query(&format!("SELECT count(*) FROM {first}")).await?;
        ctx.row_count = rows.first().and_then(|r| r[0].as_u64());
    }
    for step in t.prepare(&ctx)? {
        run_step(engine, step).await?;
    }

    let statements = t.sql(&ctx)?;
    let mut expected = t.outputs(params);
    expected.sort();
    let got: Vec<String> = statements.keys().cloned().collect();
    if expected != got {
        return Err(format!(
            "{}: sql() returned ports [{}], its outputs are [{}].",
            t.id(),
            got.join(", "),
            expected.join(", ")
        ));
    }
    let crs = t.crs(&ctx);
    if let Some(probe) = t.check(&ctx) {
        engine.query(&probe.sql).await.map_err(|e| (probe.error)(&e))?;
    }

    let mut views = BTreeMap::new();
    let mut ddl = String::from("BEGIN TRANSACTION;\n");
    for (port, sql) in &statements {
        let view = format!("{prefix}_{port}");
        ddl.push_str(&format!("CREATE OR REPLACE VIEW {} AS {sql};\n", qid(&view)));
        views.insert(port.clone(), qid(&view));
    }
    ddl.push_str("COMMIT;");
    if let Err(e) = engine.exec(&ddl).await {
        let _ = engine.exec("ROLLBACK").await;
        return Err(e);
    }
    Ok(NodeOutput { views, crs })
}
