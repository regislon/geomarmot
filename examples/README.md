# Reference transformers

Three deliberately small transformers, one per engine pattern in docs/engines.md. They are not in
the registry; they are here to be read — by people, by coding agents as examples, and by the
in-app assistant as the shape of a transformer.

| Folder | Pattern |
|---|---|
| `pure-sql/` | one SELECT per port, nothing else (the preferred pattern) |
| `sql-with-prepare/` | JavaScript work in `prepare`, into a table the SQL joins back to |
| `crs-hook/` | a transformer that changes what coordinate system the stream is in |
