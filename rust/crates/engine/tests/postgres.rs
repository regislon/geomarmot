//! PostgreSQL sources through the engine (docs/decisions/0012-database-connections.md): the allow
//! list approves exact table locations, the password comes from the app's credential lookup on
//! every (re)registration, and geometry arrives as GEOMETRY. The server tests are skipped unless
//! `GEOMARMOT_TEST_PG` is `host:port:user:database` (password in `GEOMARMOT_TEST_PG_PASSWORD`).

mod support;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use geomarmot_engine::supervisor::{Reader, SourceRecord, SourceState, Supervisor};
use geomarmot_engine::{Config, Host, SqlEngine, io};
use geomarmot_sql::pg::{PgServer, PgSource, SslMode};
use support::extension_dir;

fn server() -> Option<(PgServer, String)> {
    let spec = std::env::var("GEOMARMOT_TEST_PG").ok().filter(|s| !s.is_empty())?;
    let [host, port, user, database] = spec.split(':').collect::<Vec<_>>()[..] else {
        panic!("GEOMARMOT_TEST_PG is host:port:user:database");
    };
    Some((
        PgServer {
            host: host.into(),
            port: port.parse().unwrap(),
            database: database.into(),
            user: user.into(),
            sslmode: SslMode::Disable,
        },
        std::env::var("GEOMARMOT_TEST_PG_PASSWORD").unwrap_or_default(),
    ))
}

fn source(server: &PgServer, table: &str) -> PgSource {
    PgSource {
        server: server.clone(),
        schema: "gm_engine_test".into(),
        table: table.into(),
    }
}

#[test]
fn an_unapproved_table_is_refused_before_any_connection() {
    let host = Host::open(&Config {
        extension_dir: extension_dir(),
        ..Config::default()
    })
    .unwrap();
    let location = PgSource {
        server: PgServer {
            host: "203.0.113.1".into(),
            port: 5432,
            database: "gis".into(),
            user: "reader".into(),
            sslmode: SslMode::Require,
        },
        schema: "public".into(),
        table: "parcels".into(),
    }
    .location();
    let refused = host.import_postgres_now("t", &location, "pw").unwrap_err();
    assert!(refused.contains("was not approved"), "{refused}");
}

#[test]
fn a_postgis_table_is_a_source_that_survives_restarts() {
    let Some((server, password)) = server() else {
        return eprintln!("skipped: GEOMARMOT_TEST_PG is not set");
    };
    let mut c = geomarmot_io::postgres::connect(&server, &password).unwrap();
    c.batch_execute(
        "CREATE EXTENSION IF NOT EXISTS postgis;
         DROP SCHEMA IF EXISTS gm_engine_test CASCADE;
         CREATE SCHEMA gm_engine_test;
         CREATE TABLE gm_engine_test.roads (id int4, name text, geom geometry(LineString, 4326),
                                            area geography(Polygon, 4326));
         INSERT INTO gm_engine_test.roads
              SELECT i, 'road ' || i, ST_MakeLine(ST_Point(i, 0, 4326), ST_Point(i, 1, 4326)),
                     'POLYGON((0 0, 1 0, 1 1, 0 0))'::geography
                FROM generate_series(1, 20000) i;",
    )
    .unwrap();

    let dir = std::env::temp_dir().join(format!("gm-pg-{}", std::process::id()));
    io::clean_staging(&dir).unwrap();
    let s = Supervisor::start(
        Path::new(env!("CARGO_BIN_EXE_geomarmot-engine")),
        Config {
            extension_dir: extension_dir(),
            staging_dir: Some(dir.join("staging")),
            ..Config::default()
        },
        false,
    )
    .unwrap();
    let asked = Arc::new(AtomicUsize::new(0));
    let counter = asked.clone();
    let pw = password.clone();
    s.set_credentials(Arc::new(move |name: &str| {
        counter.fetch_add(1, Ordering::SeqCst);
        match name {
            "test-db" => Ok(pw.clone()),
            other => Err(format!("no password for {other}")),
        }
    }));

    let record = |name: &str, connection: &str| SourceRecord {
        name: name.into(),
        location: source(&server, "roads").location(),
        reader: Reader::Postgres {
            connection: connection.into(),
        },
        fingerprint: None,
    };
    let states = s.approve_source(record("pg_roads", "test-db")).unwrap();
    assert_eq!(states, vec![("pg_roads".into(), SourceState::Ready)]);
    let (_, engine) = s.engine();
    let check = || {
        let rows = pollster::block_on(engine.query(
            "SELECT count(*)::INT, ST_GeometryType(any_value(geom))::VARCHAR, round(sum(ST_Length(geom)))::INT,
                    ST_GeometryType(any_value(area))::VARCHAR FROM pg_roads",
        ))
        .unwrap();
        assert_eq!(rows[0][0], 20000);
        assert_eq!(rows[0][1], "LINESTRING");
        assert_eq!(rows[0][2], 20000);
        assert_eq!(rows[0][3], "POLYGON");
    };
    check();
    assert_eq!(asked.load(Ordering::SeqCst), 1);

    let states = s.restart().unwrap();
    assert_eq!(states[0].1, SourceState::Ready);
    assert_eq!(
        asked.load(Ordering::SeqCst),
        2,
        "the password is looked up again, not kept"
    );
    let (_, engine) = s.engine();
    let rows = pollster::block_on(engine.query("SELECT count(*)::INT FROM pg_roads")).unwrap();
    assert_eq!(rows[0][0], 20000);

    let states = s.approve_source(record("pg_other", "unknown-db")).unwrap();
    let other = states.iter().find(|(n, _)| n == "pg_other").unwrap();
    assert_eq!(other.1, SourceState::Missing("no password for unknown-db".into()));
}
