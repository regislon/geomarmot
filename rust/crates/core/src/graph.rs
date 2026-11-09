//! Compiling a whole graph: nodes in topological order, each through `compile_node`.
//!
//! A failed node reports its error and everything downstream reports "blocked", while the
//! rest of the graph still compiles (docs/architecture.md). Every compile is a generation:
//! its views are named `g<generation>_n<node>_<port>`.
// ponytail: no leases yet — the caller drops a generation once it shows the next one (one reader, the UI).

use std::collections::{BTreeMap, VecDeque};

use crate::{NodeOutput, Result, SqlEngine, compile_node, qid, transformers};
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct Node {
    /// A transformer id, or `Reader` for a registered source.
    pub kind: String,
    pub params: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Edge {
    pub from: usize,
    pub from_port: usize,
    pub to: usize,
    pub to_port: usize,
}

#[derive(Debug, Clone, Default)]
pub struct Graph {
    pub nodes: BTreeMap<usize, Node>,
    pub edges: Vec<Edge>,
}

#[derive(Debug, Clone)]
pub enum NodeState {
    Ready { ports: Vec<(String, String)>, crs: String },
    Error(String),
    Blocked,
}

/// Input and output port names of a node kind (for the canvas).
pub fn ports(node: &Node) -> (Vec<String>, Vec<String>) {
    if node.kind == "Reader" {
        return (vec![], vec!["output".into()]);
    }
    match transformers::by_id(&node.kind) {
        Some(t) => (
            t.inputs().iter().map(|s| s.to_string()).collect(),
            t.outputs(&node.params),
        ),
        None => (vec![], vec![]),
    }
}

fn order(graph: &Graph) -> Vec<usize> {
    let mut indegree: BTreeMap<usize, usize> = graph.nodes.keys().map(|&k| (k, 0)).collect();
    for e in &graph.edges {
        *indegree.entry(e.to).or_default() += 1;
    }
    let mut queue: VecDeque<usize> = indegree.iter().filter(|(_, d)| **d == 0).map(|(k, _)| *k).collect();
    let mut out = Vec::new();
    while let Some(n) = queue.pop_front() {
        out.push(n);
        for e in graph.edges.iter().filter(|e| e.from == n) {
            let d = indegree.get_mut(&e.to).unwrap();
            *d -= 1;
            if *d == 0 {
                queue.push_back(e.to);
            }
        }
    }
    out
}

async fn reader(engine: &impl SqlEngine, node: &Node, prefix: &str) -> Result<NodeOutput> {
    let relation = node
        .params
        .get("relation")
        .and_then(Value::as_str)
        .ok_or("Open a file for this Reader.")?;
    let crs = node
        .params
        .get("crs")
        .and_then(Value::as_str)
        .unwrap_or("EPSG:4326")
        .to_string();
    let view = qid(&format!("{prefix}_output"));
    engine
        .exec(&format!(
            "CREATE OR REPLACE VIEW {view} AS SELECT * FROM {}",
            qid(relation)
        ))
        .await?;
    Ok(NodeOutput {
        views: BTreeMap::from([("output".into(), view)]),
        crs,
    })
}

pub async fn compile_graph(engine: &impl SqlEngine, graph: &Graph, generation: u64) -> BTreeMap<usize, NodeState> {
    let mut states = BTreeMap::new();
    for id in order(graph) {
        let node = &graph.nodes[&id];
        let prefix = format!("g{generation}_n{id}");
        let (inputs, _) = ports(node);
        let mut resolved = BTreeMap::new();
        let mut blocked = false;
        for (k, port) in inputs.iter().enumerate() {
            let Some(e) = graph.edges.iter().find(|e| e.to == id && e.to_port == k) else {
                continue;
            };
            match states.get(&e.from) {
                Some(NodeState::Ready { ports, crs }) => {
                    if let Some((_, view)) = ports.get(e.from_port) {
                        resolved.insert(port.clone(), (view.clone(), crs.clone()));
                    }
                }
                _ => blocked = true,
            }
        }
        if blocked {
            states.insert(id, NodeState::Blocked);
            continue;
        }
        let result = if node.kind == "Reader" {
            reader(engine, node, &prefix).await
        } else {
            match transformers::by_id(&node.kind) {
                Some(t) => compile_node(engine, t, &node.params, &resolved, &prefix).await,
                None => Err(format!("{} is not ported yet.", node.kind)),
            }
        };
        let (_, outputs) = ports(node);
        states.insert(
            id,
            match result {
                Ok(out) => NodeState::Ready {
                    ports: outputs
                        .iter()
                        .filter_map(|p| Some((p.clone(), out.views.get(p)?.clone())))
                        .collect(),
                    crs: out.crs,
                },
                Err(e) => NodeState::Error(e),
            },
        );
    }
    states
}

/// Drop every view and table of a generation.
pub async fn drop_generation(engine: &impl SqlEngine, generation: u64) {
    let like = format!("g{generation}\\_n%");
    let found = engine
        .query(&format!(
            "SELECT table_name, table_type FROM information_schema.tables WHERE table_name LIKE '{like}' ESCAPE '\\'"
        ))
        .await
        .unwrap_or_default();
    for row in found {
        let (Some(name), Some(kind)) = (row[0].as_str(), row[1].as_str()) else {
            continue;
        };
        let what = if kind == "VIEW" { "VIEW" } else { "TABLE" };
        let _ = engine.exec(&format!("DROP {what} IF EXISTS {}", qid(name))).await;
    }
}
