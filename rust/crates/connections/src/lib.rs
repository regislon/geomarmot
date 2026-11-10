//! Saved database connections (docs/decisions/0012-database-connections.md).
//!
//! A connection has a name; graphs refer to it by that name only. Its server, database, role
//! and TLS mode are kept in `connections.json` in the user's configuration directory, which
//! holds no secret and can be shared. Its password is kept in the OS credential store (macOS
//! Keychain, Windows Credential Manager, the Secret Service on Linux) and read each time a
//! table is opened. It is never written to a file, a graph, an export, a URL or a log.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use geomarmot_sql::Result;
use geomarmot_sql::pg::{PgServer, PgSource, SslMode};
use serde_json::{Value, json};

/// The credential store's service name; each connection is an account under it.
pub const SERVICE: &str = "geomarmot.database";

/// A saved connection: a name, and how to reach the server (no password).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Connection {
    pub name: String,
    pub server: PgServer,
}

/// Where passwords live.
pub trait Vault: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>>;
    fn set(&self, name: &str, password: &str) -> Result<()>;
    fn delete(&self, name: &str) -> Result<()>;
}

/// The OS credential store, through the `keyring` crate.
#[cfg(not(target_arch = "wasm32"))]
pub struct Keychain;

#[cfg(not(target_arch = "wasm32"))]
impl Keychain {
    fn entry(name: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, name).map_err(|e| format!("credential store: {e}"))
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Vault for Keychain {
    fn get(&self, name: &str) -> Result<Option<String>> {
        match Self::entry(name)?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("credential store: {e}")),
        }
    }

    fn set(&self, name: &str, password: &str) -> Result<()> {
        Self::entry(name)?
            .set_password(password)
            .map_err(|e| format!("credential store: {e}"))
    }

    fn delete(&self, name: &str) -> Result<()> {
        match Self::entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("credential store: {e}")),
        }
    }
}

/// Passwords in memory, for tests.
#[derive(Default)]
pub struct MemoryVault(Mutex<std::collections::BTreeMap<String, String>>);

impl Vault for MemoryVault {
    fn get(&self, name: &str) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap().get(name).cloned())
    }

    fn set(&self, name: &str, password: &str) -> Result<()> {
        self.0.lock().unwrap().insert(name.into(), password.into());
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<()> {
        self.0.lock().unwrap().remove(name);
        Ok(())
    }
}

/// The user's configuration directory for GeoMarmot (`GEOMARMOT_CONFIG_DIR` overrides it).
pub fn config_dir() -> Result<PathBuf> {
    let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    if let Some(dir) = env("GEOMARMOT_CONFIG_DIR") {
        return Ok(dir);
    }
    if cfg!(target_os = "windows") {
        return env("APPDATA")
            .map(|d| d.join("GeoMarmot"))
            .ok_or("APPDATA is not set".into());
    }
    let home = env("HOME").ok_or("HOME is not set")?;
    if cfg!(target_os = "macos") {
        return Ok(home.join("Library/Application Support/GeoMarmot"));
    }
    Ok(env("XDG_CONFIG_HOME")
        .unwrap_or_else(|| home.join(".config"))
        .join("geomarmot"))
}

/// Saved connections: a JSON file for the details, a vault for the passwords.
pub struct Store {
    file: PathBuf,
    vault: Arc<dyn Vault>,
}

fn check_name(name: &str) -> Result<()> {
    if name.trim().is_empty() || name != name.trim() {
        return Err("a connection needs a name without leading or trailing spaces".into());
    }
    if name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err("a connection name is at most 100 printable characters".into());
    }
    Ok(())
}

fn to_json(c: &Connection) -> Value {
    let s = &c.server;
    json!({ "name": c.name, "host": s.host, "port": s.port, "database": s.database,
            "user": s.user, "sslmode": s.sslmode.as_str() })
}

fn from_json(v: &Value) -> Result<Connection> {
    let text = |k: &str| {
        v[k].as_str()
            .map(String::from)
            .ok_or_else(|| format!("connection without {k}"))
    };
    Ok(Connection {
        name: text("name")?,
        server: PgServer {
            host: text("host")?,
            port: v["port"]
                .as_u64()
                .and_then(|p| u16::try_from(p).ok())
                .ok_or("connection without a port")?,
            database: text("database")?,
            user: text("user")?,
            sslmode: SslMode::parse(v["sslmode"].as_str().unwrap_or("prefer"))?,
        },
    })
}

impl Store {
    /// The user's store: `connections.json` in `config_dir()`, passwords in the OS keychain.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn open_default() -> Result<Self> {
        Ok(Self::new(&config_dir()?.join("connections.json"), Arc::new(Keychain)))
    }

    pub fn new(file: &Path, vault: Arc<dyn Vault>) -> Self {
        Self {
            file: file.to_path_buf(),
            vault,
        }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    /// Every saved connection, sorted by name. No file yet means none.
    pub fn list(&self) -> Result<Vec<Connection>> {
        let text = match std::fs::read_to_string(&self.file) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(format!("{}: {e}", self.file.display())),
        };
        let doc: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", self.file.display()))?;
        let mut list: Vec<Connection> = doc["connections"]
            .as_array()
            .into_iter()
            .flatten()
            .map(from_json)
            .collect::<Result<_>>()?;
        list.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(list)
    }

    pub fn get(&self, name: &str) -> Result<Connection> {
        self.list()?
            .into_iter()
            .find(|c| c.name == name)
            .ok_or_else(|| format!("no saved database connection named {name:?}"))
    }

    fn write(&self, list: &[Connection]) -> Result<()> {
        let dir = self.file.parent().ok_or("connections file has no directory")?;
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let doc = json!({ "version": 1, "connections": list.iter().map(to_json).collect::<Vec<_>>() });
        let partial = self.file.with_extension("json.partial");
        std::fs::write(&partial, serde_json::to_string_pretty(&doc).unwrap_or_default())
            .map_err(|e| format!("{}: {e}", partial.display()))?;
        std::fs::rename(&partial, &self.file).map_err(|e| format!("{}: {e}", self.file.display()))
    }

    /// Add or replace `connection`. `password`: `Some` stores it (an empty one removes it, for
    /// servers that need none); `None` keeps the stored one.
    pub fn save(&self, connection: &Connection, password: Option<&str>) -> Result<()> {
        check_name(&connection.name)?;
        let mut list = self.list()?;
        list.retain(|c| c.name != connection.name);
        list.push(connection.clone());
        list.sort_by(|a, b| a.name.cmp(&b.name));
        match password {
            Some("") => self.vault.delete(&connection.name)?,
            Some(p) => self.vault.set(&connection.name, p)?,
            None => {}
        }
        self.write(&list)
    }

    /// Forget a connection and its password.
    pub fn remove(&self, name: &str) -> Result<()> {
        let mut list = self.list()?;
        list.retain(|c| c.name != name);
        self.vault.delete(name)?;
        self.write(&list)
    }

    /// The stored password of `name`; empty when none is stored.
    pub fn password(&self, name: &str) -> Result<String> {
        Ok(self.vault.get(name)?.unwrap_or_default())
    }

    pub fn has_password(&self, name: &str) -> bool {
        matches!(self.vault.get(name), Ok(Some(_)))
    }

    /// The location of `schema.table` on connection `name`.
    pub fn source(&self, name: &str, schema: &str, table: &str) -> Result<PgSource> {
        Ok(PgSource {
            server: self.get(name)?.server,
            schema: schema.into(),
            table: table.into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(dir: &Path) -> Store {
        Store::new(&dir.join("sub/connections.json"), Arc::new(MemoryVault::default()))
    }

    fn conn(name: &str) -> Connection {
        Connection {
            name: name.into(),
            server: PgServer {
                host: "db.example.org".into(),
                port: 5432,
                database: "gis".into(),
                user: "reader".into(),
                sslmode: SslMode::Require,
            },
        }
    }

    fn tempdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gm-connections-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_file_holds_details_and_the_vault_holds_the_password() {
        let dir = tempdir("split");
        let s = store(&dir);
        assert!(s.list().unwrap().is_empty(), "no file yet: no connections");
        s.save(&conn("prod"), Some("hunter2-secret")).unwrap();
        s.save(&conn("dev"), None).unwrap();
        let text = std::fs::read_to_string(s.file()).unwrap();
        assert!(!text.contains("hunter2-secret"), "{text}");
        assert!(!text.contains("password"), "{text}");
        assert_eq!(
            s.list().unwrap().iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["dev", "prod"]
        );
        assert_eq!(s.get("prod").unwrap(), conn("prod"));
        assert_eq!(s.password("prod").unwrap(), "hunter2-secret");
        assert!(!s.has_password("dev"));
        assert_eq!(s.password("dev").unwrap(), "");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn saving_without_a_password_keeps_it_and_removing_forgets_it() {
        let dir = tempdir("keep");
        let s = store(&dir);
        s.save(&conn("prod"), Some("pw")).unwrap();
        let mut moved = conn("prod");
        moved.server.port = 6543;
        s.save(&moved, None).unwrap();
        assert_eq!(s.get("prod").unwrap().server.port, 6543);
        assert_eq!(s.password("prod").unwrap(), "pw");
        s.save(&moved, Some("")).unwrap();
        assert!(!s.has_password("prod"), "an empty password removes it");
        s.save(&moved, Some("pw2")).unwrap();
        s.remove("prod").unwrap();
        assert!(s.get("prod").unwrap_err().contains("no saved database connection"));
        assert!(!s.has_password("prod"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn names_are_checked_and_sources_carry_no_password() {
        let dir = tempdir("names");
        let s = store(&dir);
        assert!(s.save(&conn(" padded"), None).is_err());
        assert!(s.save(&conn(""), None).is_err());
        assert!(s.save(&conn("tab\there"), None).is_err());
        s.save(&conn("prod"), Some("pw-in-vault")).unwrap();
        let location = s.source("prod", "public", "parcels").unwrap().location();
        assert!(!location.contains("pw-in-vault"));
        assert_eq!(PgSource::parse(&location).unwrap().table, "parcels");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The real OS credential store: `cargo test -p geomarmot-connections -- --ignored`.
    #[test]
    #[ignore = "writes to the user's credential store"]
    fn the_keychain_round_trips_a_password() {
        let name = format!("geomarmot-test-{}", std::process::id());
        Keychain.set(&name, "kc-test-pw").unwrap();
        assert_eq!(Keychain.get(&name).unwrap().as_deref(), Some("kc-test-pw"));
        Keychain.delete(&name).unwrap();
        assert_eq!(Keychain.get(&name).unwrap(), None);
    }
}
