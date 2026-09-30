# Deliberate shortcuts

Every shortcut taken on purpose, with the milestone that removes it. Agents and humans edit this
file directly.

| Shortcut | Why | Cleared in |
|---|---|---|
| `transformers/legacy.js` and `_kit/legacy-adapter.js` present pre-kit entries through the contract | lets groups move into folders one at a time | M3 (PR 21) |
| Legacy `prepare` tables are named `h3cells_<ns>_g<gen>_<node>…` instead of `ctx.tableName()` | the adapter keeps them unique per generation | as each group moves (M3) |
| Legacy `prepare` steps do not check `ctx.signal` | only native prepare steps can be aborted mid-batch | as each group moves (M3) |
| JSTS geometry work runs on the main thread | caps and yielding keep the page responsive; not true isolation | M7 |
