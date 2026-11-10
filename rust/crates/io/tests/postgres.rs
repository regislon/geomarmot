//! The PostgreSQL reader against a real PostGIS server. Skipped unless `GEOMARMOT_TEST_PG` is
//! `host:port:user:database` (and `GEOMARMOT_TEST_PG_PASSWORD` the role's password); the role
//! needs CREATE on the database and PostGIS installed (`CREATE EXTENSION postgis`).

use geomarmot_io::postgres::{connect, list_tables, read_table};
use geomarmot_sql::arrow::array::{Array, AsArray, RecordBatch};
use geomarmot_sql::arrow::datatypes::{DataType, Float64Type, Int32Type, Int64Type, TimeUnit};
use geomarmot_sql::pg::{PgServer, PgSource, SslMode};

pub fn server() -> Option<(PgServer, String)> {
    let spec = std::env::var("GEOMARMOT_TEST_PG").ok().filter(|s| !s.is_empty())?;
    let [host, port, user, database] = spec.split(':').collect::<Vec<_>>()[..] else {
        panic!("GEOMARMOT_TEST_PG is host:port:user:database");
    };
    let server = PgServer {
        host: host.into(),
        port: port.parse().unwrap(),
        database: database.into(),
        user: user.into(),
        sslmode: SslMode::Disable,
    };
    Some((server, std::env::var("GEOMARMOT_TEST_PG_PASSWORD").unwrap_or_default()))
}

fn setup(server: &PgServer, password: &str) {
    let mut c = connect(server, password).unwrap();
    c.batch_execute(
        "CREATE EXTENSION IF NOT EXISTS postgis;
         DROP SCHEMA IF EXISTS gm_io_test CASCADE;
         CREATE SCHEMA gm_io_test;
         CREATE TABLE gm_io_test.\"Parcels\" (
            id int4 PRIMARY KEY, big int8, ok bool, area numeric(10,2), name text, kind varchar(5),
            born date, seen timestamp, at timestamptz, tags text[], geom geometry(Polygon, 2056));
         INSERT INTO gm_io_test.\"Parcels\" VALUES
            (1, 9000000000, true, 12.5, 'Bern', 'a', DATE '2020-01-02', TIMESTAMP '2020-01-02 03:04:05',
             TIMESTAMPTZ '2020-01-02 03:04:05+01', ARRAY['x','y'],
             ST_GeomFromText('POLYGON((2600000 1200000, 2600010 1200000, 2600010 1200010, 2600000 1200000))', 2056)),
            (2, NULL, NULL, NULL, NULL, NULL, 'infinity', NULL, NULL, NULL, NULL);
         CREATE VIEW gm_io_test.plain AS SELECT id, name FROM gm_io_test.\"Parcels\";",
    )
    .unwrap();
}

fn source(server: &PgServer, table: &str) -> PgSource {
    PgSource {
        server: server.clone(),
        schema: "gm_io_test".into(),
        table: table.into(),
    }
}

#[test]
fn reads_a_postgis_table_with_its_types_and_crs() {
    let Some((server, password)) = server() else {
        return eprintln!("skipped: GEOMARMOT_TEST_PG is not set");
    };
    setup(&server, &password);

    let tables = list_tables(&server, &password).unwrap();
    let ours: Vec<_> = tables.iter().filter(|t| t.schema == "gm_io_test").collect();
    assert_eq!(ours.len(), 2, "{tables:?}");
    assert_eq!(ours[0].table, "Parcels");
    assert_eq!(ours[0].geometry.as_deref(), Some("geom"));
    assert_eq!(ours[1].geometry, None);
    assert!(
        !tables.iter().any(|t| t.table == "spatial_ref_sys"),
        "extension tables are not listed"
    );

    let mut batches: Vec<RecordBatch> = Vec::new();
    let mut began = false;
    let table = read_table(
        &source(&server, "Parcels"),
        &password,
        |t| {
            began = true;
            assert_eq!(t.rows, 0);
            Ok(())
        },
        |b| {
            batches.push(b);
            Ok(())
        },
    )
    .unwrap();
    assert!(began);
    assert_eq!(table.rows, 2);
    assert_eq!(table.crs.as_deref(), Some("EPSG:2056"));
    assert_eq!(table.geometry, vec!["geom".to_string()]);
    let types: Vec<(String, DataType)> = table
        .schema
        .fields()
        .iter()
        .map(|f| (f.name().clone(), f.data_type().clone()))
        .collect();
    assert_eq!(
        types,
        vec![
            ("id".into(), DataType::Int32),
            ("big".into(), DataType::Int64),
            ("ok".into(), DataType::Boolean),
            ("area".into(), DataType::Float64),
            ("name".into(), DataType::Utf8),
            ("kind".into(), DataType::Utf8),
            ("born".into(), DataType::Date32),
            ("seen".into(), DataType::Timestamp(TimeUnit::Microsecond, None)),
            (
                "at".into(),
                DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into()))
            ),
            ("tags".into(), DataType::Utf8),
            ("geom".into(), DataType::Binary),
        ]
    );
    let b = &batches[0];
    assert_eq!(b.column(0).as_primitive::<Int32Type>().values(), &[1, 2]);
    assert_eq!(b.column(1).as_primitive::<Int64Type>().value(0), 9_000_000_000);
    assert_eq!(b.column(3).as_primitive::<Float64Type>().value(0), 12.5);
    assert_eq!(b.column(4).as_string::<i32>().value(0), "Bern");
    assert_eq!(b.column(9).as_string::<i32>().value(0), "{x,y}");
    assert!(b.column(6).is_null(1), "an infinite date is null");
    // 2020-01-02 03:04:05+01 is 02:04:05 UTC.
    let at = b
        .column(8)
        .as_primitive::<geomarmot_sql::arrow::datatypes::TimestampMicrosecondType>();
    assert_eq!(at.value(0), 1_577_930_645_000_000);
    let wkb = b.column(10).as_binary::<i32>();
    assert_eq!(&wkb.value(0)[..5], &[1, 3, 0, 0, 0], "little-endian WKB polygon");
    assert!(wkb.is_null(1));

    let prefer = PgServer {
        sslmode: SslMode::Prefer,
        ..server.clone()
    };
    assert!(connect(&prefer, &password).is_ok(), "prefer falls back to plain TCP");

    let view = read_table(&source(&server, "plain"), &password, |_| Ok(()), |_| Ok(())).unwrap();
    assert_eq!((view.rows, view.crs), (2, None));
}

#[test]
fn errors_name_the_problem_and_never_the_password() {
    let Some((server, password)) = server() else {
        return eprintln!("skipped: GEOMARMOT_TEST_PG is not set");
    };
    let missing = read_table(&source(&server, "no_such_table"), &password, |_| Ok(()), |_| Ok(()));
    assert!(missing.unwrap_err().contains("does not exist"));

    let wrong = "not-the-password-4711";
    let refused = connect(&server, wrong).err().expect("a wrong password is refused");
    assert!(refused.contains("password authentication failed"), "{refused}");
    assert!(!refused.contains(wrong));

    let gone = PgServer {
        port: 1,
        ..server.clone()
    };
    let unreachable = connect(&gone, &password).err().unwrap();
    assert!(unreachable.starts_with(&format!("could not connect to {}:1", server.host)));
    assert!(password.is_empty() || !unreachable.contains(&password));
}
