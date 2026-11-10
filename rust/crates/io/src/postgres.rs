//! PostgreSQL and PostGIS tables as Arrow (docs/decisions/0012-database-connections.md).
//!
//! Only trusted I/O talks to the server: DuckDB never sees the connection or the password.
//! Every read runs in a read-only transaction. Types are mapped on the server, so this side
//! handles a fixed set: geometry and geography arrive as WKB, numeric as double, dates and
//! timestamps as integers, anything else as text.

use std::sync::Arc;
use std::time::Duration;

use geomarmot_sql::Result;
use geomarmot_sql::arrow::array::{
    ArrayRef, BinaryArray, BooleanArray, Date32Array, Float32Array, Float64Array, Int16Array, Int32Array, Int64Array,
    RecordBatch, StringArray, TimestampMicrosecondArray,
};
use geomarmot_sql::arrow::datatypes::{DataType, Field, Schema, SchemaRef, TimeUnit};
use geomarmot_sql::pg::{PgServer, PgSource, SslMode};
use postgres::{Client, NoTls, Row};

/// Rows per batch: about the 4 MB batches the engine uses elsewhere for typical tables.
pub const BATCH_ROWS: i32 = 8192;

/// A table or view the user may read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableInfo {
    pub schema: String,
    pub table: String,
    /// Its first geometry or geography column, if any.
    pub geometry: Option<String>,
}

/// What `read_table` found: the Arrow schema, geometry columns (WKB) and their CRS.
#[derive(Debug, Clone)]
pub struct PgTable {
    pub schema: SchemaRef,
    /// Geometry and geography columns, in table order, as WKB.
    pub geometry: Vec<String>,
    /// `EPSG:<srid>` of the first geometry column, when it has one.
    pub crs: Option<String>,
    pub rows: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Bool,
    I16,
    I32,
    I64,
    F32,
    F64,
    Text,
    Bytes,
    Date,
    Timestamp,
    TimestampTz,
    Geometry,
    Geography,
}

impl Kind {
    fn of(type_name: &str) -> Self {
        match type_name {
            "bool" => Kind::Bool,
            "int2" => Kind::I16,
            "int4" => Kind::I32,
            "int8" => Kind::I64,
            "float4" => Kind::F32,
            "float8" | "numeric" => Kind::F64,
            "bytea" => Kind::Bytes,
            "date" => Kind::Date,
            "timestamp" => Kind::Timestamp,
            "timestamptz" => Kind::TimestampTz,
            "geometry" => Kind::Geometry,
            "geography" => Kind::Geography,
            _ => Kind::Text,
        }
    }

    /// The expression that brings column `c` (quoted) to this side in a known type.
    fn select(self, c: &str) -> String {
        let epoch = |c: &str| format!("CASE WHEN isfinite({c}) THEN (extract(epoch FROM {c}) * 1000000)::int8 END");
        match self {
            Kind::F64 => format!("{c}::float8"),
            Kind::Text => format!("{c}::text"),
            Kind::Date => format!("CASE WHEN isfinite({c}) THEN {c} - DATE '1970-01-01' END"),
            Kind::Timestamp | Kind::TimestampTz => epoch(c),
            Kind::Geometry => format!("ST_AsBinary({c})"),
            Kind::Geography => format!("ST_AsBinary({c}::geometry)"),
            _ => c.to_string(),
        }
    }

    fn arrow(self) -> DataType {
        match self {
            Kind::Bool => DataType::Boolean,
            Kind::I16 => DataType::Int16,
            Kind::I32 => DataType::Int32,
            Kind::I64 => DataType::Int64,
            Kind::F32 => DataType::Float32,
            Kind::F64 => DataType::Float64,
            Kind::Text => DataType::Utf8,
            Kind::Bytes | Kind::Geometry | Kind::Geography => DataType::Binary,
            Kind::Date => DataType::Date32,
            Kind::Timestamp => DataType::Timestamp(TimeUnit::Microsecond, None),
            Kind::TimestampTz => DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
        }
    }

    /// Column `i` of `rows` as an Arrow array.
    fn column(self, rows: &[Row], i: usize) -> ArrayRef {
        fn get<'a, T: postgres::types::FromSql<'a>>(rows: &'a [Row], i: usize) -> Vec<Option<T>> {
            rows.iter().map(|r| r.get::<_, Option<T>>(i)).collect()
        }
        match self {
            Kind::Bool => Arc::new(BooleanArray::from(get::<bool>(rows, i))),
            Kind::I16 => Arc::new(Int16Array::from(get::<i16>(rows, i))),
            Kind::I32 => Arc::new(Int32Array::from(get::<i32>(rows, i))),
            Kind::I64 => Arc::new(Int64Array::from(get::<i64>(rows, i))),
            Kind::F32 => Arc::new(Float32Array::from(get::<f32>(rows, i))),
            Kind::F64 => Arc::new(Float64Array::from(get::<f64>(rows, i))),
            Kind::Text => Arc::new(StringArray::from(get::<&str>(rows, i))),
            Kind::Bytes | Kind::Geometry | Kind::Geography => Arc::new(BinaryArray::from(get::<&[u8]>(rows, i))),
            Kind::Date => Arc::new(Date32Array::from(get::<i32>(rows, i))),
            Kind::Timestamp => Arc::new(TimestampMicrosecondArray::from(get::<i64>(rows, i))),
            Kind::TimestampTz => Arc::new(TimestampMicrosecondArray::from(get::<i64>(rows, i)).with_timezone("UTC")),
        }
    }
}

/// A quoted PostgreSQL identifier.
fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// The error and its causes, without the connection parameters (which hold the password).
fn pe(e: postgres::Error) -> String {
    if let Some(db) = e.as_db_error() {
        return db.message().to_string();
    }
    let mut text = e.to_string();
    let mut cause = std::error::Error::source(&e);
    while let Some(c) = cause {
        text = format!("{text}: {c}");
        cause = c.source();
    }
    text
}

fn tls() -> Result<tokio_postgres_rustls::MakeRustlsConnect> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = rustls_platform_verifier::Verifier::new(provider.clone()).map_err(|e| e.to_string())?;
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    Ok(tokio_postgres_rustls::MakeRustlsConnect::new(config))
}

/// Open a connection. `password` is used for this connection only and never kept.
pub fn connect(server: &PgServer, password: &str) -> Result<Client> {
    let mut config = postgres::Config::new();
    config
        .host(&server.host)
        .port(server.port)
        .dbname(&server.database)
        .user(&server.user)
        .application_name("geomarmot")
        .connect_timeout(Duration::from_secs(10));
    if !password.is_empty() {
        config.password(password);
    }
    let connected = match server.sslmode {
        SslMode::Disable => config.ssl_mode(postgres::config::SslMode::Disable).connect(NoTls),
        SslMode::Prefer => config.ssl_mode(postgres::config::SslMode::Prefer).connect(tls()?),
        SslMode::Require => config.ssl_mode(postgres::config::SslMode::Require).connect(tls()?),
    };
    connected.map_err(|e| format!("could not connect to {}:{}: {}", server.host, server.port, pe(e)))
}

/// Tables, views and materialised views the role may read, outside system and extension schemas.
pub fn list_tables(server: &PgServer, password: &str) -> Result<Vec<TableInfo>> {
    let mut client = connect(server, password)?;
    let rows = client
        .query(
            "SELECT n.nspname::text, c.relname::text,
                    (SELECT a.attname::text FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
                      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                        AND t.typname IN ('geometry', 'geography') ORDER BY a.attnum LIMIT 1)
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f')
                AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
                AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
                AND has_table_privilege(c.oid, 'SELECT')
              ORDER BY 1, 2",
            &[],
        )
        .map_err(pe)?;
    Ok(rows
        .iter()
        .map(|r| TableInfo {
            schema: r.get(0),
            table: r.get(1),
            geometry: r.get(2),
        })
        .collect())
}

/// Read `source` in batches of `BATCH_ROWS`: `begin` gets the table's description once, before
/// any batch; `batch` gets each batch. Stops at the first error either returns.
pub fn read_table(
    source: &PgSource,
    password: &str,
    begin: impl FnOnce(&PgTable) -> Result<()>,
    mut batch: impl FnMut(RecordBatch) -> Result<()>,
) -> Result<PgTable> {
    let mut client = connect(&source.server, password)?;
    let mut tx = client.build_transaction().read_only(true).start().map_err(pe)?;
    let columns: Vec<(String, Kind)> = tx
        .query(
            "SELECT a.attname::text, t.typname::text
               FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
              WHERE a.attrelid = to_regclass(quote_ident($1) || '.' || quote_ident($2))
                AND a.attnum > 0 AND NOT a.attisdropped
              ORDER BY a.attnum",
            &[&source.schema, &source.table],
        )
        .map_err(pe)?
        .iter()
        .map(|r| (r.get(0), Kind::of(r.get(1))))
        .collect();
    if columns.is_empty() {
        return Err(format!(
            "{}.{} does not exist, has no columns, or cannot be read",
            source.schema, source.table
        ));
    }
    let relation = format!("{}.{}", ident(&source.schema), ident(&source.table));
    let geometry: Vec<String> = columns
        .iter()
        .filter(|(_, k)| matches!(k, Kind::Geometry | Kind::Geography))
        .map(|(n, _)| n.clone())
        .collect();
    let crs = match geometry.first() {
        Some(g) => {
            let sql = format!(
                "SELECT ST_SRID({c}) FROM {relation} WHERE {c} IS NOT NULL LIMIT 1",
                c = ident(g)
            );
            tx.query_opt(&sql, &[])
                .map_err(pe)?
                .map(|r| r.get::<_, i32>(0))
                .filter(|srid| *srid > 0)
                .map(|srid| format!("EPSG:{srid}"))
        }
        None => None,
    };
    let schema: SchemaRef = Arc::new(Schema::new(
        columns
            .iter()
            .map(|(n, k)| Field::new(n, k.arrow(), true))
            .collect::<Vec<_>>(),
    ));
    let mut table = PgTable {
        schema: schema.clone(),
        geometry,
        crs,
        rows: 0,
    };
    begin(&table)?;
    let select: Vec<String> = columns.iter().map(|(n, k)| k.select(&ident(n))).collect();
    let portal = tx
        .bind(&format!("SELECT {} FROM {relation}", select.join(", ")), &[])
        .map_err(pe)?;
    loop {
        let rows = tx.query_portal(&portal, BATCH_ROWS).map_err(pe)?;
        if rows.is_empty() {
            break;
        }
        let arrays: Vec<ArrayRef> = columns
            .iter()
            .enumerate()
            .map(|(i, (_, k))| k.column(&rows, i))
            .collect();
        table.rows += rows.len();
        batch(RecordBatch::try_new(schema.clone(), arrays).map_err(|e| e.to_string())?)?;
    }
    tx.commit().map_err(pe)?;
    Ok(table)
}
