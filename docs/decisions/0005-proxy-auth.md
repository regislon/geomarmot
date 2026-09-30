# 0005 — Launch token exchanged for a session cookie

**Status:** accepted (gate S5)

## Context

The local server proxies cloud buckets with the user's own credentials, so no other web page may be
able to use it. DuckDB reads remote files with range requests made from its own worker, so the app
cannot add a custom header to them.

## Findings

A local server that requires a session cookie received it on every request DuckDB made for
`registerFileURL` Parquet, GeoPackage (`st_read`) and CSV reads, and on the app's own `fetch`
calls. Only the footer and the needed row groups were fetched (2.8 MB of an 88 MB file). Without the
cookie every read failed.

## Decision

The CLI opens `http://127.0.0.1:<port>/#t=<token>`. The page removes the fragment and calls
`POST /session` with the token in `X-GeoMarmot-Token`; the server answers with an
`HttpOnly; SameSite=Strict; Path=/` session cookie. Proxy, listing and AI routes require it, along
with a loopback `Host`, a same-origin `Origin` when present, and `Sec-Fetch-Site` of `same-origin`
or `none` when present.
