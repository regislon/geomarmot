//! Spike gate 6, lifecycle: a retired generation's views and `prepare` tables are gone once it
//! is dropped, and the generation that replaced it is untouched.

mod support;

use geomarmot_core::graph::{Edge, Graph, Node, NodeState, compile_graph, drop_generation};
use geomarmot_engine::{Config, Host, SqlEngine};
use serde_json::json;

async fn relations(host: &Host, generation: u64) -> usize {
    let rows = host
        .query(&format!(
            "SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'g{generation}\\_n%' ESCAPE '\\'"
        ))
        .await
        .unwrap();
    rows[0][0].as_u64().unwrap() as usize
}

#[test]
fn retiring_a_generation_frees_its_relations() {
    let host = Host::open(&Config {
        extension_dir: support::extension_dir(),
        ..Config::default()
    })
    .unwrap();
    pollster::block_on(async {
        host.exec(
            "CREATE TABLE src AS SELECT i AS id, ST_Buffer(ST_Point(i * 0.5, 0), 1) AS geometry FROM range(4) t(i)",
        )
        .await
        .unwrap();
        // A reader, then an overlay: views per port plus the overlay's prepare tables.
        let graph = Graph {
            nodes: [
                (
                    0,
                    Node {
                        kind: "Reader".into(),
                        params: json!({ "relation": "src" }),
                    },
                ),
                (
                    1,
                    Node {
                        kind: "AreaOnAreaOverlayer".into(),
                        params: json!({}),
                    },
                ),
            ]
            .into(),
            edges: vec![Edge {
                from: 0,
                from_port: 0,
                to: 1,
                to_port: 0,
            }],
        };
        let first = compile_graph(&host, &graph, 1).await;
        assert!(matches!(first[&1], NodeState::Ready { .. }), "{:?}", first[&1]);
        let made = relations(&host, 1).await;
        assert!(made >= 6, "views and prepare tables of generation 1: {made}");
        compile_graph(&host, &graph, 2).await;
        drop_generation(&host, 1).await;
        assert_eq!(relations(&host, 1).await, 0, "generation 1 is gone");
        assert_eq!(relations(&host, 2).await, made, "generation 2 is untouched");
        let rows = host.query("SELECT count(*) FROM g2_n1_output").await.unwrap();
        assert!(rows[0][0].as_u64().unwrap() > 0);
    });
}
