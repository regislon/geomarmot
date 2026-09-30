# Deliberate shortcuts

Every shortcut taken on purpose, with the milestone that removes it. Agents and humans edit this
file directly.

| Shortcut | Why | Cleared in |
|---|---|---|
| JSTS geometry work runs on the main thread | caps and yielding keep the page responsive; not true isolation | M7 |
| Export Cancel on a query that ignores cancelSent restarts the engine | exports run on the main connection's non-streaming path, so cancelSent rarely reaches them | M7 (stream exports on their own connection) |
| Applied draft nodes are placed right of their upstream, which can be outside the visible canvas while the assistant drawer is open | the canvas has no pan-to-fit yet | M7 (fit view on apply) |
| "Export as folder" exports generated transformers made of SQL steps only | a call step is a node, not code; exporting it needs a composition API in the kit | M7 |
| Generated transformers kept in IndexedDB cannot be deleted from the UI | nothing lists them yet; clearing site data removes them | M7 (manage generated transformers) |

