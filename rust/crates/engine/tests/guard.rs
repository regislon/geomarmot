//! The SQL guard's cases from `tests/browser/sqlguard.spec.js`, on the native engine.

mod support;

use geomarmot_core::sqlguard::{Context, validate};
use geomarmot_engine::{Config, Host};
use support::extension_dir;

const REFUSED: &[(&str, &str)] = &[
    ("a file-reading table function", "SELECT * FROM read_csv('x.csv')"),
    ("GDAL", "SELECT * FROM st_read('a.gpkg')"),
    ("a replacement scan", "SELECT * FROM 'x.parquet'"),
    (
        "a table function in a subquery",
        "SELECT input.*, (SELECT count(*) FROM read_parquet('y')) AS n FROM input",
    ),
    (
        "glob in a set operation",
        "SELECT 1 AS a UNION ALL SELECT * FROM glob('*')",
    ),
    (
        "a settings table function",
        "SELECT * FROM input, LATERAL (SELECT * FROM duckdb_settings())",
    ),
    ("ATTACH", "ATTACH 'other.db'"),
    ("COPY", "COPY input TO 'out.csv'"),
    ("SET", "SET memory_limit = '1GB'"),
    ("PRAGMA", "PRAGMA version"),
    ("stacked statements", "SELECT input.*, 1 AS a FROM input; SELECT 2"),
    ("a statement behind a comment", "SELECT 1 /* ; */ ; COPY input TO 'x'"),
    ("another node's view", "SELECT * FROM m_g1_n2_output"),
    ("a qualified relation", "SELECT * FROM main.secrets"),
    ("getenv", "SELECT getenv('HOME') AS h FROM input"),
    ("current_setting", "SELECT current_setting('threads') AS t FROM input"),
    ("DROP", "DROP TABLE input"),
];

const ACCEPTED: &[(&str, &str)] = &[
    ("a plain query", "SELECT input.*, v * 2 AS v2 FROM input"),
    ("its own CTE", "WITH t AS (SELECT id FROM input) SELECT * FROM t"),
    (
        "a recursive CTE",
        "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT * FROM r",
    ),
    ("spatial functions", "SELECT ST_AsText(ST_Point(1, 2)) AS p FROM input"),
    ("a trailing semicolon", "SELECT * FROM input;"),
];

#[test]
fn guard_matches_the_browser_suite() {
    let host = Host::open(&Config {
        extension_dir: extension_dir(),
        ..Config::default()
    })
    .unwrap();
    pollster::block_on(async {
        let mut wrong = Vec::new();
        for (what, sql) in REFUSED {
            if validate(&host, sql, Context::Query).await.is_ok() {
                wrong.push(format!("accepted {what}: {sql}"));
            }
        }
        for (what, sql) in ACCEPTED {
            if let Err(r) = validate(&host, sql, Context::Query).await {
                wrong.push(format!("refused {what}: {sql} ({})", r.message));
            }
        }
        assert!(validate(&host, "upper(name) || '!'", Context::Expression).await.is_ok());
        for sql in [
            "1) FROM input; SELECT * FROM read_csv('x') --",
            "(SELECT count(*) FROM read_csv('x'))",
        ] {
            if validate(&host, sql, Context::Expression).await.is_ok() {
                wrong.push(format!("accepted expression {sql}"));
            }
        }
        assert!(wrong.is_empty(), "\n{}", wrong.join("\n"));
    });
}
