# 0012 — Database connections: saved by name, passwords in the OS keychain

**Status:** proposed (Rust desktop app)

## Context

The Rust desktop app gains a PostgreSQL / PostGIS reader. Reading a table needs a host, a database,
a role and usually a password. A graph is a file people send each other, so it must not carry a
password. Re-typing the password for every table and every run is not workable either: the engine
re-reads its sources on every restart (approving a new source, escalated cancel).

The browser build cannot open a TCP connection, so it has no database reader.

## Decision

**Connections are saved by name**, and a graph refers to a connection by that name only. A
Reader of a database table keeps `connection`, `schema`, `table` and the `crs` it found. Someone
who opens the graph on another machine creates a connection with the same name, pointing at their
own server and role.

| What | Where |
|---|---|
| Name, host, port, database, user, TLS mode | `connections.json` in the user's configuration directory (`~/Library/Application Support/GeoMarmot` on macOS, `%APPDATA%\GeoMarmot` on Windows, `$XDG_CONFIG_HOME/geomarmot` on Linux; `GEOMARMOT_CONFIG_DIR` overrides it). No secret; can be copied between machines. |
| Password | The OS credential store through the `keyring` crate: macOS Keychain, Windows Credential Manager, the Secret Service (GNOME Keyring, KWallet) on Linux. Service `geomarmot.database`, one account per connection name. |
| Graph file | The connection's name, the schema and the table. |

The OS store is preferred over an encrypted file of our own: the key protecting an encrypted file
would have to live beside it or in the app, and the OS store already ties secrets to the user's
login, with the platform's own access prompts.

**How the password travels.** The app process reads it from the keychain each time the engine
registers the source (`Supervisor::set_credentials`), and sends it to the engine process over the
private stdin pipe with the import request. It is never on a command line or in the environment
(both visible to other processes), never in the engine's allow list or source records, and never
in a log or an error message. The engine uses it for one connection and drops it.

**How the table is read.** Trusted I/O in the engine process (`geomarmot-io::postgres`, on the
`postgres` crate) reads the table in a read-only transaction and appends it to DuckDB as Arrow
batches; geometry and geography columns arrive as WKB and become `GEOMETRY`. DuckDB never sees the
connection, so neither restricted nor unrestricted SQL can reach the server. The allow list approves
the exact table location (`postgresql://user@host:port/db?sslmode=…&schema=…&table=…`), which has
no password and is refused if it contains one.

**TLS.** `disable`, `prefer` (TLS when the server offers it, the default) or `require` (TLS, with a
certificate the system trust store accepts: rustls with the platform verifier).

## Consequences

- The rule in AGENTS.md about where keys live gains the desktop keychain, as the migration plan
  anticipated for API keys.
- A table is copied into the engine, not scanned lazily, and is read again on every engine restart.
  Recorded in `docs/debt.md`.
- Opening a graph connects to the servers its Readers name, as opening it re-reads its files. A
  graph cannot name a server: only a connection the user saved.
- Tests against a server run when `GEOMARMOT_TEST_PG` names one; without it they are skipped.
