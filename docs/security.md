# Security and privacy

GeoMarmot runs in the browser. Data you open is read there and never uploaded; the local server
only serves the app, relays bucket reads with your own credentials, and (optionally) relays
assistant requests with a key from its environment. This page describes each boundary and what
enforces it.

## The local server

The server holds your cloud credentials and possibly an AI key, so no other page may reach it.

| Check | What it stops | Where |
|---|---|---|
| `Host` must be `localhost`, `127.0.0.1` or `[::1]` | DNS rebinding, other machines | `server/geomarmot/guard.py` |
| `Origin`, when present, must be a loopback origin | cross-site requests | same |
| `Sec-Fetch-Site`, when present, must be `same-origin` or `none` | cross-site requests | same |
| `/proxy`, `/list` and `/ai` need a session cookie | any page that was not opened with the launch token | same |

The CLI opens `http://127.0.0.1:<port>/#t=<token>`. The page trades the token for an
`HttpOnly; SameSite=Strict` session cookie (`POST /session`) and removes it from the address bar.
A cookie, not a header, because DuckDB-Wasm makes its range requests from its own worker and cannot
add headers ([ADR 0005](decisions/0005-proxy-auth.md)). The proxy only ever talks to the storage
host, never to a host taken from the request. There are no CORS headers. Remote access is not
supported in v0.1: the server binds `127.0.0.1` (and `0.0.0.0` only inside a container, where the
Host rule still refuses anything but loopback names).

## SQL

Some parameters take SQL: SQLTransformer's query, AttributeCreator's SQL mode, and the SQL kind of
a value spec (inside AttributeCreator, AttributeManager and VertexCreator). That SQL is untrusted:
it may come from a file someone sent you, or from the assistant.

- **Restricted by default.** Every node with SQL is `restricted` unless you switch it to
  unrestricted in the inspector and confirm. Editing a field never changes the mode. A graph
  opened from a file comes back restricted, with a banner naming the nodes that asked otherwise;
  the assistant cannot set the mode at all.
- **The guard.** In restricted mode each SQL fragment is checked before anything runs
  (`app/src/core/sqlguard/`): it is parsed with DuckDB's own `json_serialize_sql` — parsed, never
  executed — in a placeholder form, and refused unless it is a single SELECT that reads only the
  node's inputs, calls no table function, and uses no function on the deny-list (settings, files,
  environment). The transformer then splices the fragment with the same function that built the
  placeholder form, so what runs is what was checked.
- **Defence in depth.** Extension autoloading and autoinstalling are switched off after boot.
- **Limits.** Interactive reads are stopped after 30 s: first cancelled, and if the engine does not
  answer within 2 s, restarted with every source registered again
  ([ADR 0004](decisions/0004-sql-inspection-and-cancellation.md)). Memory is capped at 60% of the
  device's, at most 4 GB. JavaScript geometry work (JSTS) still runs on the main thread in v0.1;
  it is capped and yields, but is not isolated.

## The assistant

The assistant is off until you add a key or the local server has one. Its settings choose what it
may see.

### Keys

A key typed into the settings is kept in `sessionStorage` (gone when the tab closes) unless you
choose "Remember on this device" (`localStorage`); "Forget key" removes it from both. It is sent
only to the provider, from the browser, through the provider's SDK. It is never written into a
graph, the autosave, an export or the console, and a test checks that. With the "local server"
route there is no key in the page at all: the server reads `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`,
adds it, and never returns or logs it ([ADR 0009](decisions/0009-ai-relay.md)).

### Data levels

Everything sent to a provider goes through one function, the privacy gate
(`app/src/ai/gate/`). Each kind of payload has a JSON Schema per level with every object closed;
the gate refuses a payload with anything extra rather than stripping it.

| Level | What may leave the browser |
|---|---|
| 1 (default) | column names and types, row counts, CRS, the graph's structure, the params you entered, and **structured errors only** |
| 2 | adds, per column: min, max, share of nulls, distinct count, extent, and up to 5 top values of at most 100 characters |
| 3 | adds up to 20 sample or preview rows (200 characters a cell) and raw error text (500 characters) |

**Structured errors.** At levels 1 and 2 no error text from DuckDB reaches the provider, because
DuckDB quotes the offending value ("Could not convert string '…' to INT32"). The error is sorted
into a fixed catalogue of codes (`COLUMN_NOT_FOUND`, `CONVERSION_FAILED`, `SQL_FORBIDDEN_CONSTRUCT`,
…) whose params can only be identifiers, type names, CRS codes and counts, and the message is
rebuilt from those params. Anything not recognised becomes `UNKNOWN_ERROR` with no params. You still
see the full error in the chat, marked local-only.

**Values the assistant wrote.** At level 3 the assistant could copy a value it saw — a name from a
sample row — into a param. Every value it writes is recorded in the node's `paramOrigin` with the
highest level the conversation had reached. When params are sent at a lower level, those values
are replaced by `{ "redacted": "derived from data above the current level" }`. Values you typed,
or change yourself, are always sent. Two kinds of value are never redacted, because they cannot
carry data: choices from a fixed list, and column names (sent at level 1 anyway). The origin is
kept through Apply, undo and redo, autosave, and saving and opening a graph file.

**Lowering the level ends the conversation.** Assistant replies can quote data they were shown, and
that cannot be filtered afterwards. So when the level goes down, the request in flight is
cancelled and its result discarded, and the next request starts a new conversation carrying only
the system prompt, your own typed messages, and a summary of the graph built by the app at the new
level. The chat keeps the full history for you, marked as not sent. Raising the level keeps the
conversation.

**What the assistant may not do.** It cannot add a Reader or a Writer (so it can neither open new
files nor write output), cannot set a node's SQL mode, and every SQL fragment it writes goes
through the guard above, at proposal and again at every compile.
