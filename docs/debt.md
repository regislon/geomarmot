# Deliberate shortcuts

Every shortcut taken on purpose, with the milestone that removes it. Agents and humans edit this
file directly.

| Shortcut | Why | Cleared in |
|---|---|---|
| JSTS geometry work runs on the main thread | caps and yielding keep the page responsive; not true isolation | M7 |
| Export Cancel on a query that ignores cancelSent restarts the engine | exports run on the main connection's non-streaming path, so cancelSent rarely reaches them | M7 (stream exports on their own connection) |
