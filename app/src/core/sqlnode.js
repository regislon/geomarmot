/*
 * Shared plumbing for the nodes whose parameter *is* a DuckDB query.
 *
 * Two of them exist — AttributeCreator, which must add columns, and
 * SQLTransformer, which may do anything a SELECT can. Both bind the incoming
 * stream to the name `input` so a query reads the way someone would write it by
 * hand, without knowing the generated view names, and both validate the same
 * way. Keeping that in one place means a fix to the composition rules reaches
 * both rather than only the one being worked on.
 */

import { qid, readQuery } from "./duck.js";
import { describe } from "./schema.js";

/** Statements that have no business in a slot that must yield a relation. */
const NOT_A_QUERY =
  /^(insert|update|delete|create|drop|alter|attach|detach|copy|pragma|set|call|export|install|load|begin|commit|rollback|vacuum|checkpoint|use)\b/i;

/** Leading line and block comments — an AI-written query often opens with one. */
const LEADING_COMMENTS = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/;

/**
 * Bind `input` to the upstream view, splicing rather than nesting.
 *
 * The obvious composition — `WITH input AS (…) <query>` — is a syntax error the
 * moment the query has a CTE of its own, because SQL allows one WITH clause per
 * statement. Anything an AI writes tends to open with `WITH`, so the user's list
 * is merged into ours instead: their `WITH` keyword is dropped and their CTEs
 * become further entries after `input`. `WITH RECURSIVE` has to keep RECURSIVE
 * in front of the whole list, which is legal even though `input` is not itself
 * recursive.
 */
export function composeSql(sql, upstreamView) {
  const body = String(sql || "")
    .trim()
    .replace(/;\s*$/, "");
  const bind = `input AS (SELECT * FROM ${upstreamView})`;

  const recursive = body.match(/^with\s+recursive\s+/i);
  if (recursive) return `WITH RECURSIVE ${bind}, ${body.slice(recursive[0].length)}`;
  const plain = body.match(/^with\s+/i);
  if (plain) return `WITH ${bind}, ${body.slice(plain[0].length)}`;
  return `WITH ${bind} ${body}`;
}

/*
 * What the query must look like, and what this engine actually accepts.
 *
 * Every line was checked against the engine in the browser rather than written
 * from memory of DuckDB in general: this is duckdb-wasm 1.29 reporting DuckDB
 * v1.1.1, and `* RENAME` — which the docs of later versions describe — is a
 * parser error here. A reference that lies about one item is worse than none,
 * because the reader has no way to tell which item it is.
 */
export const SYNTAX_REFERENCE = `Shape
  Single SELECT statement. No semicolon, no second statement.
  Read from the table \`input\`; keep \`input.*\` and add columns beside it.
  At least one column must be new, or the node is rejected.
  CTEs are fine, including WITH RECURSIVE — write WITH as you normally would.

Identifiers and literals
  "double quotes" for column names with spaces, accents or capitals.
  'single quotes' for string values.

Supported here
  SELECT * EXCLUDE (a, b)        drop columns from the star
  SELECT * REPLACE (expr AS a)   overwrite a column in place
  COLUMNS('regex')               select columns by pattern
  expr::TYPE, TRY_CAST(x AS T)   casting; TRY_CAST yields NULL instead of failing
  CASE WHEN … THEN … ELSE … END
  window functions, QUALIFY
  [1, 2, 3] lists, {'k': v} structs
  func(arg, named := value)      named arguments use :=

NOT supported here
  SELECT * RENAME (a AS b)       parser error on DuckDB 1.1.1 — use
                                 * EXCLUDE (a), a AS b instead

Geometry
  ST_Point(lon, lat)                       point from two numeric columns
  ST_GeomFromText(wkt)                     geometry from a WKT string column
  ST_Transform(g, 'EPSG:4326', 'EPSG:3857', always_xy := true)
  always_xy is not optional in practice: without it PROJ honours EPSG:4326's
  latitude-first axis order and the coordinates come back swapped.
  A new GEOMETRY column is picked up by the map with no further wiring.

Area, and a trap
  Measure area by projecting to an equal-area CRS first:
      ST_Area(ST_Transform(g, 'EPSG:4326', 'EPSG:6933', always_xy := true))
  That is metres squared, within ~0.5% at any latitude.
  Do NOT use ST_Area_Spheroid on this build: it returns the same area for a
  1x1 degree box at every latitude, so it is right at the equator and 2.8x
  too large at 69 degrees north. Measured, not inferred.
  ST_Area(g) on lon/lat is square degrees, which is not an area at all.`;

/*
 * Categorical values, for the benefit of whoever writes the query.
 *
 * Names and types are not enough to write a WHERE clause: knowing there is a
 * `traceability_type` column does not tell you it holds "farm" and
 * "supply_shed". An assistant given the values writes a query that matches the
 * data; one given only the schema invents plausible strings that match nothing.
 *
 * One query for the whole table — 53 columns would otherwise be 53 round trips,
 * and the cost here turns out to scale with the number of aggregates rather
 * than the number of rows (81 columns cost the same over 2,000 rows as over
 * 20,000). Asking `approx_top_k` for one more value than the categorical
 * cut-off is what makes a single pass enough: a column with fewer distinct
 * values than k returns all of them, and one that returns exactly k has more
 * than we would call categories, so no separate count is needed.
 */
export const PROFILE_ROWS = 20000;
/** Above this many distinct values a column is data, not a category. */
const MAX_CATEGORIES = 25;
/** Continuous types are excluded: the distinct values of an area are not a set. */
const CATEGORICAL_TYPE = /^(VARCHAR|BOOLEAN|DATE|U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT)\b/;

const profileCache = new Map();

/**
 * Forget the cached profiles so the next request re-reads the rows.
 *
 * Not called on every rebuild, deliberately. The profile costs seconds on a
 * wide table, the AttributeCreator's own edits cannot change its input, and
 * every keystroke schedules a rebuild — clearing on rebuild would put a
 * multi-second query behind each burst of typing and starve the query check.
 * Node ids are never reused, so a cached view name always means the same node;
 * what a rebuild can change is the rows behind it, which is why the panel says
 * the values come from a sample and offers this as a button.
 */
export function clearProfiles() {
  profileCache.clear();
}

function profileKey(view, columns) {
  return `${view}|${columns.map((column) => `${column.name}:${column.type}`).join(",")}`;
}

/**
 * Map of column name -> its distinct values, for the columns that look
 * categorical.
 *
 * Read from the first PROFILE_ROWS rows, so it is cheap on a big table and
 * honest about being partial — a file sorted by the very column being profiled
 * can show fewer categories than it really has.
 */
export async function profileCategories(view, columns) {
  if (!view) return new Map();
  const cacheKey = profileKey(view, columns);
  if (profileCache.has(cacheKey)) return profileCache.get(cacheKey);

  const pending = (async () => {
    const candidates = columns.filter((column) => CATEGORICAL_TYPE.test(column.type));
    const found = new Map();
    if (!candidates.length) return found;

    // Positional aliases: a column name cannot be trusted to be a legal alias,
    // and two columns differing only in case would collide.
    const projection = candidates
      .map((column, index) => `approx_top_k(${qid(column.name)}, ${MAX_CATEGORIES + 1}) AS v${index}`)
      .join(", ");
    const row = (await readQuery(`SELECT ${projection} FROM (SELECT * FROM ${view} LIMIT ${PROFILE_ROWS})`))[0] || {};

    candidates.forEach((column, index) => {
      const raw = row[`v${index}`];
      // null rather than [] when every value in the column is NULL.
      if (!Array.isArray(raw) || !raw.length) return;
      // Exactly k back means there are more values than we would call
      // categories, and a truncated list would read as the whole set.
      if (raw.length > MAX_CATEGORIES) return;
      // approx_top_k orders by frequency; sort so the list is stable between
      // renders rather than whatever the scan happened to produce.
      found.set(column.name, raw.map((value) => String(value)).sort());
    });
    return found;
  })();

  // Cached as the promise, so a re-render mid-flight joins the running profile
  // instead of starting a second one.
  profileCache.set(cacheKey, pending);
  try {
    return await pending;
  } catch (err) {
    // A profile is a convenience; losing it must not break the editor.
    profileCache.delete(cacheKey);
    console.warn("Could not profile categories", err);
    return new Map();
  }
}

/** The schema an AI needs to write the query, as SQL-ish text it can be handed. */
export function schemaText(columns, categories = new Map()) {
  if (!columns.length) return "-- table input: schema unknown until the input is connected";
  const width = Math.max(...columns.map((column) => column.name.length));
  const typeWidth = Math.max(...columns.map((column) => column.type.length));
  const lines = columns.map((column) => {
    const head = `${column.name.padEnd(width)}  ${column.type}`;
    const values = categories.get(column.name);
    if (!values) return head;
    // Padded to the type column so the value lists line up as their own column.
    return `${head.padEnd(width + 2 + typeWidth)}  -- ${values.map((value) => `'${value}'`).join(", ")}`;
  });
  return ["-- table input", ...lines].join("\n");
}

/** Schema plus rules, so one paste gives an AI everything it needs. */
export function promptText(columns, categories = new Map()) {
  return [
    "Write a DuckDB SELECT for the GeoMarmot AttributeCreator node.",
    "",
    SYNTAX_REFERENCE,
    "",
    "Input schema",
    schemaText(columns, categories),
    "",
    categories.size
      ? `-- Comments list every distinct value of the columns that have at most ${MAX_CATEGORIES},` +
        `\n-- taken from the first ${PROFILE_ROWS.toLocaleString()} rows. Match them exactly.`
      : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/** Everything past the first statement, so a second one can be refused by name. */
function trailingStatement(body) {
  const semicolon = body.indexOf(";");
  if (semicolon === -1) return "";
  return body.slice(semicolon + 1).trim();
}

/**
 * Check a query in the slot it is going into.
 *
 * `requireNewColumns` is what separates the two nodes: an AttributeCreator that
 * adds nothing is a no-op wearing a transformer's clothes, and saying so beats
 * leaving someone to wonder why the output looks unchanged.
 *
 * Returns a verdict rather than throwing, because both callers want to say
 * something useful about a bad query — the inspector under the editor, the
 * compiler as the node's error.
 */
export async function checkSql(sql, upstreamView, inputColumns, { requireNewColumns = false } = {}) {
  const body = String(sql || "")
    .trim()
    .replace(/;\s*$/, "");
  if (!body) {
    return { ok: true, empty: true, message: "Empty — rows pass through unchanged.", columns: [] };
  }

  const statement = body.replace(LEADING_COMMENTS, "");
  if (NOT_A_QUERY.test(statement)) {
    const verb = statement.split(/\s+/)[0].toUpperCase();
    return { ok: false, message: `${verb} is not a query. This node needs a SELECT that returns rows.` };
  }
  const trailing = trailingStatement(body);
  if (trailing) {
    return { ok: false, message: "One statement only — everything after the first ; would be ignored." };
  }
  if (!upstreamView) {
    return { ok: false, message: "Connect an input before the query can be checked." };
  }

  let columns;
  try {
    columns = await describe(`(${composeSql(body, upstreamView)})`);
  } catch (err) {
    // DuckDB names the offending column or token, which beats anything we could
    // say about it — so pass its message through, trimmed of the boilerplate.
    return { ok: false, message: String(err.message || err).replace(/^Error:\s*/, "") };
  }

  const before = new Set(inputColumns.map((column) => column.name));
  const added = columns.filter((column) => !before.has(column.name));
  const dropped = inputColumns.filter((column) => !columns.some((existing) => existing.name === column.name));

  if (requireNewColumns && !added.length) {
    return {
      ok: false,
      message: "The query runs but adds no attribute. Keep `input.*` and add at least one new column.",
      columns,
    };
  }

  const notes = [`${added.length} new: ${added.map((column) => column.name).join(", ") || "none"}`];
  // Not an error — `SELECT * EXCLUDE (…)` can be deliberate — but silently
  // losing a column you meant to keep is worth seeing.
  if (dropped.length) notes.push(`drops ${dropped.map((column) => column.name).join(", ")}`);
  return { ok: true, message: notes.join(" · "), columns, added, dropped };
}
