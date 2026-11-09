//! Compiling one node into views (spike scope: no graph, generations or leases yet).
//!
//! Mirrors `app/src/core/graph/compiler.js` + `node.js` for a single node:
//! resolve inputs and the incoming CRS, DESCRIBE inputs when needed, run
//! sql → crs → check, then create one view per output port in one transaction.

use std::collections::BTreeMap;

use crate::{Ctx, Engine, LONLAT, Result, Transformer, qid};
use serde_json::Value;

pub struct NodeOutput {
    /// Port id → view name.
    pub views: BTreeMap<String, String>,
    pub crs: String,
}

/// `inputs`: port → (relation, CRS). `prefix` names the node's views.
pub fn compile_node(
    engine: &Engine,
    t: &dyn Transformer,
    params: &Value,
    inputs: &BTreeMap<String, (String, String)>,
    prefix: &str,
) -> Result<NodeOutput> {
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
    let mut schemas = BTreeMap::new();
    if t.needs_schema() {
        for (port, relation) in &relations {
            schemas.insert(port.clone(), engine.describe(relation)?);
        }
    }
    let ctx = Ctx {
        node_type: t.id().to_string(),
        params: params.clone(),
        inputs: relations,
        schemas,
        incoming_crs: crs_seen.pop().unwrap_or_else(|| LONLAT.to_string()),
    };

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
    t.check(&ctx, engine)?;

    let mut views = BTreeMap::new();
    let mut ddl = String::from("BEGIN TRANSACTION;\n");
    for (port, sql) in &statements {
        let view = format!("{prefix}_{port}");
        ddl.push_str(&format!("CREATE OR REPLACE VIEW {} AS {sql};\n", qid(&view)));
        views.insert(port.clone(), qid(&view));
    }
    ddl.push_str("COMMIT;");
    if let Err(e) = engine.exec(&ddl) {
        let _ = engine.exec("ROLLBACK");
        return Err(e);
    }
    Ok(NodeOutput { views, crs })
}
