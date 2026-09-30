# Evals

`npm run eval` runs the requests in [`cases.json`](cases.json) against a real model, through the
built app in Chromium, applies each draft and checks that it contains the nodes (and params) the
case expects. It is how to tell whether a change to the system prompt, the tools or the catalogue
made the assistant better or worse.

```bash
ANTHROPIC_API_KEY=... npm run eval
ANTHROPIC_API_KEY=... npm run eval -- --only filter
ANTHROPIC_API_KEY=... npm run eval -- --model claude-sonnet-5-5
```

It calls the real API and costs real tokens — a few short conversations per run — so it is not part
of CI. The key is typed into the page's settings as a user would; it stays in that browser session.

Add a case when you fix a bad answer: the request, the CSV it needs, the data level, and the node
types (with `params` checked by path, such as `"conditions.0.value"`) the applied draft must contain.
Keep the expectations to what any good answer must have, not to one particular graph.
