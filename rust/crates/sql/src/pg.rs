//! A PostgreSQL table as a source location: everything needed to reach it except the password.
//!
//! The location is what the engine's allow list approves, what the supervisor keeps in its
//! source records, and what crosses to the engine process. The password never appears in it:
//! the app reads it from the OS keychain and sends it beside the location for each import
//! (docs/decisions/0012-database-connections.md).

use crate::Result;

/// How the connection uses TLS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SslMode {
    /// Plain TCP (a server on this machine or a trusted network).
    Disable,
    /// TLS when the server offers it, plain otherwise.
    #[default]
    Prefer,
    /// TLS, or fail. The certificate is checked against the system's trust store.
    Require,
}

impl SslMode {
    pub const ALL: [SslMode; 3] = [SslMode::Disable, SslMode::Prefer, SslMode::Require];

    pub fn as_str(self) -> &'static str {
        match self {
            SslMode::Disable => "disable",
            SslMode::Prefer => "prefer",
            SslMode::Require => "require",
        }
    }

    pub fn parse(text: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|m| m.as_str() == text)
            .ok_or_else(|| format!("unknown sslmode {text:?} (disable, prefer or require)"))
    }
}

/// A server, database and role: a saved connection without its name and password.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PgServer {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub sslmode: SslMode,
}

/// One table (or view) of a server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PgSource {
    pub server: PgServer,
    pub schema: String,
    pub table: String,
}

const SCHEME: &str = "postgresql://";

/// Percent-encode everything but unreserved characters, so any name round-trips.
fn enc(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn dec(text: &str) -> Result<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3).ok_or("bad escape in location")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "bad escape in location")?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "location is not UTF-8".into())
}

impl PgSource {
    /// `postgresql://user@host:port/database?sslmode=…&schema=…&table=…`, every part encoded.
    pub fn location(&self) -> String {
        let s = &self.server;
        format!(
            "{SCHEME}{}@{}:{}/{}?sslmode={}&schema={}&table={}",
            enc(&s.user),
            enc(&s.host),
            s.port,
            enc(&s.database),
            s.sslmode.as_str(),
            enc(&self.schema),
            enc(&self.table)
        )
    }

    pub fn is_location(text: &str) -> bool {
        text.starts_with(SCHEME)
    }

    /// The inverse of `location`. Refuses anything with a password in it.
    pub fn parse(text: &str) -> Result<Self> {
        let rest = text.strip_prefix(SCHEME).ok_or("not a postgresql:// location")?;
        let (authority, rest) = rest.split_once('/').ok_or("location has no database")?;
        let (database, query) = rest.split_once('?').ok_or("location has no table")?;
        let (user, hostport) = authority.split_once('@').ok_or("location has no user")?;
        if user.contains(':') {
            return Err("a location never carries a password".into());
        }
        let (host, port) = hostport.rsplit_once(':').ok_or("location has no port")?;
        let mut sslmode = None;
        let mut schema = None;
        let mut table = None;
        for pair in query.split('&') {
            match pair.split_once('=') {
                Some(("sslmode", v)) => sslmode = Some(SslMode::parse(v)?),
                Some(("schema", v)) => schema = Some(dec(v)?),
                Some(("table", v)) => table = Some(dec(v)?),
                _ => return Err(format!("unexpected location parameter {pair:?}")),
            }
        }
        Ok(Self {
            server: PgServer {
                host: dec(host)?,
                port: port.parse().map_err(|_| "bad port in location")?,
                database: dec(database)?,
                user: dec(user)?,
                sslmode: sslmode.unwrap_or_default(),
            },
            schema: schema.ok_or("location has no schema")?,
            table: table.ok_or("location has no table")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_location_round_trips_any_name() {
        let source = PgSource {
            server: PgServer {
                host: "db.example.org".into(),
                port: 5433,
                database: "gis data".into(),
                user: "r&d@team".into(),
                sslmode: SslMode::Require,
            },
            schema: "Public".into(),
            table: "parcels?=&/x".into(),
        };
        let text = source.location();
        assert!(PgSource::is_location(&text));
        assert_eq!(PgSource::parse(&text).unwrap(), source);
    }

    #[test]
    fn a_location_with_a_password_is_refused() {
        let text = "postgresql://me:secret@localhost:5432/db?sslmode=disable&schema=public&table=t";
        assert!(PgSource::parse(text).unwrap_err().contains("password"));
    }
}
