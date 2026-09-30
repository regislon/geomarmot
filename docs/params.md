# Parameter kinds, fixtures and documentation rules

## Parameter kinds

Build every parameter with `param.<kind>(id, label, options)` from `transformers/_kit`. The kind
decides the inspector's editor, a fresh node's empty value, and **how the value reaches SQL** —
which is what the SQL guard and the escaping contract test key on.

| Kind | Editor | Empty value | Reaches SQL as |
|---|---|---|---|
| `string` | text field | — | a quoted or validated literal |
| `number` | text field | — | a validated literal |
| `select` | dropdown of `options` | — | a literal |
| `source` | the Layers rail's sources | — | never (the Reader looks it up) |
| `column` | one of the input's attributes | — | a quoted identifier |
| `columns` | several attributes, with select-all | `[]` | quoted identifiers |
| `valuespec` | constant · attribute · formula · SQL | — | an **expression** when its kind is SQL, otherwise a literal or identifier |
| `conditions` | attribute · operator · value rows | `[]` | literals |
| `renames` | from → to rows | `[]` | identifiers |
| `valuerows` | name + value-spec rows | `[]` | expressions (SQL value specs) |
| `creates` | name + value-spec rows (older form) | `[]` | expressions |
| `actions` | AttributeManager's edit rows | `[]` | expressions (SQL value specs) |
| `sorts` | attribute + ASC/DESC rows | `[]` | identifiers |
| `aggregates` | function · attribute · name rows | `[]` | identifiers |
| `values` | a list of values | `[]` | literals |
| `rules` | label · attribute · operator · value rows | `[]` | literals |
| `joinkeys` | left = right pairs | `[]` | identifiers |
| `choices` | check boxes of `choices` | `[]` | never (read by JavaScript) |
| `sqltext` | SQL editor | — | a **query** |
| `sqlcreate` | SQL editor with schema panel and live check | — | a **query** |

Options every kind accepts:

| Option | |
|---|---|
| `description` | required, at least 10 words |
| `default` | the value a fresh node starts with |
| `placeholder` | the field's hint text |
| `when(node)` | show the field only when this returns true |
| `units` | "m", "ha", "degrees", … — say them in the label too |
| `options` (select) | `[{ value, description }]`; every option needs a description |
| `coverage: "one"` (select) | for a select of levels (resolutions, passes): fixtures need one case, not one per option |
| `filter: "numeric"` (columns) | offer numeric columns only |

`expression` and `query` values are **untrusted SQL**. A transformer must splice them only with
the kit's `spliceExpression(fragment)` and `spliceQuery(fragment, relation)`, which build exactly
the form the SQL guard validated (docs/security.md).

## Fixtures (`tests.json`)

```json
{
  "transformer": "Tester",
  "cases": [
    {
      "name": "AND of two conditions; NULL goes to failed",
      "params": { "logic": "AND", "conditions": [{ "column": "v", "operator": ">", "value": "5" }] },
      "inputs": {
        "input": {
          "crs": "EPSG:4326",
          "columns": [{ "name": "id", "type": "INTEGER" }, { "name": "v", "type": "DOUBLE" }],
          "rows": [[1, 10.5], [2, null]]
        }
      },
      "expect": {
        "passed": { "columns": [{ "name": "id", "type": "INTEGER" }, { "name": "v", "type": "DOUBLE" }], "rows": [[1, 10.5]] },
        "failed": { "columns": [{ "name": "id", "type": "INTEGER" }, { "name": "v", "type": "DOUBLE" }], "rows": [[2, null]] }
      }
    }
  ]
}
```

- **Inputs** are typed tables (GEOMETRY cells as WKT). Each is fed through a test-only
  `FixtureSource` carrying the case's `crs`, so projected inputs can be tested. An input with no
  rows is still typed.
- **`source`** instead of `inputs` writes a real Parquet file (`fileName`, `columns`, `rows`,
  `readerParams`) and reads it through a real Reader — for behaviour that depends on the file, such
  as H3 defaults from the file name.
- **`expect`** has one entry per output port (`columns` compared by name, order and type; `rows` as
  a multiset unless `"ordered": true`), an optional `crs`, or `{ "error": "<substring>" }`.
- **`assert`** instead of `expect`, for random output: `rowCount { min, max }`,
  `subsetOf: "input"`, `columnsEqual: "input"`, `unique: [columns]`.
- **`sink: true`** cases run the Writer and compare the file: `expect.file` with `name` and `text`
  (text formats) or `table` (binary formats, read back through the Reader).
- **Values**: 64-bit integers, dates and timestamps are written as text; GEOMETRY as WKT.
- **`geometry`**: `{ "mode": "exact" }` (default — same type, dimensions, part order, ring start
  and orientation, coordinates within `tolerance`), relaxed per case with `"ignore": ["ringStart",
  "orientation", "partOrder"]` and a required `"why"`; or `{ "mode": "topology", "tolerance",
  "areaTolerance" }` for algorithm output (symmetric-difference area and Hausdorff distance).

`npm run check:fixtures` enforces the rules: the file exists and has cases; every output port is
exercised; every select option has a case (a warning until v0.2, except `coverage: "one"`);
at most 50 KB per file and 50 rows per input; a `why` for every `ignore`. Whether the cases pass
is `npm run test:browser`. Capture a new case's expectation with
`node scripts/capture-expectations.js --only <Id>` — then read it before committing it.

## Documentation rules

`npm run check:docs` refuses a transformer unless:

| Field | Rule |
|---|---|
| `summary` | one sentence, 20–160 characters |
| `description` | at least 60 words: what it does, how, and what it does not do |
| `whenToUse` | at least 2 situations, phrased as a user would ask |
| `whenNotToUse` | at least 1, naming the transformer to use instead |
| `keywords` | at least 3, with synonyms |
| `examples` | at least 1: input → params → output, in words |
| each param | a description of at least 10 words, not equal to its label; every select option described |
| each port | a description |

and its `README.md` has these headings, in order, none empty: *What it does · When to use it ·
When not to use it · Parameters · Output ports · Examples · Limitations · Credits*. Placeholder
text (`TODO`, the scaffold's guidance comments) fails the check.
