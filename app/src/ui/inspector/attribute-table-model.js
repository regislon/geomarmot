// @ts-check
/*
 * AttributeManager's edits as a table, and back.
 *
 * The node stores an ordered list of edits (Set value, Rename, Copy to,
 * Create, Convert, Remove). The table shows one row per attribute instead: every input
 * attribute, then the attributes the edits add. A row says what becomes of
 * its attribute — its output name, a new value, a new type, or removal.
 *
 * Saved back, the rows become edits in a fixed order, so that every value
 * reads the input's attributes under their input names:
 *   copies, then values set, then created attributes, then conversions, then renames,
 *   then removals.
 * A list written in another order (by hand, or by the assistant) may not come
 * back exactly; `exact` says so, and the table warns before it rewrites it.
 */

/** @typedef {{ kind?: string, [key: string]: any }} ValueSpec */
/**
 * @typedef {object} Row
 * @property {string|null} input   the input attribute, or null for a created one
 * @property {string} output       its name on the way out
 * @property {ValueSpec|null} spec a new value, or null to keep it
 * @property {string|null} convert  a type to convert to (one of CONVERT_TYPES), or null to keep it
 * @property {boolean} remove
 * @property {boolean} added       a row the table added (copy or create), not an input attribute
 * @property {string} type         the input attribute's type, for display
 */

/** What a row does, as the Action column says it. */
export function rowAction(row) {
  if (row.remove) return "Remove";
  if (row.added) return row.input ? "Copy" : "Create";
  const renamed = row.output !== row.input;
  if (row.spec && renamed) return "Rename and set value";
  if (row.spec) return "Set value";
  if (renamed) return "Rename";
  if (row.convert) return "Convert";
  return "Do nothing";
}

const clone = (value) => (value == null ? null : JSON.parse(JSON.stringify(value)));

/**
 * @param {Array<any>} actions                        the node's edits
 * @param {Array<{ name: string, type?: string }>} columns  the input's attributes
 * @returns {{ rows: Row[], exact: boolean }}
 */
export function toRows(actions, columns) {
  /** @type {Row[]} */
  const rows = columns.map((column) => ({
    input: column.name,
    output: column.name,
    spec: null,
    convert: null,
    remove: false,
    added: false,
    type: column.type || "",
  }));
  const byOutput = (name) => rows.find((row) => !row.remove && row.output === name);
  let exact = true;
  for (const action of actions || []) {
    const spec = clone(action.spec) || (action.value ? { kind: "SQL", sql: action.value } : null);
    const row = action.column ? byOutput(action.column) : null;
    switch (action.action) {
      case "Rename":
        if (row && action.target) row.output = action.target;
        else exact = false;
        break;
      case "Set value":
        if (row && spec) row.spec = spec;
        else exact = false;
        break;
      case "Copy to":
        if (row?.input && action.target) {
          rows.push({
            input: row.input,
            output: action.target,
            spec: null,
            convert: null,
            remove: false,
            added: true,
            type: row.type,
          });
        } else exact = false;
        break;
      case "Create":
        if (action.target && spec) {
          rows.push({ input: null, output: action.target, spec, convert: null, remove: false, added: true, type: "" });
        } else exact = false;
        break;
      case "Convert":
        if (row && action.to) row.convert = action.to;
        else exact = false;
        break;
      case "Remove":
        if (row) row.remove = true;
        else exact = false;
        break;
      default:
        exact = false;
    }
  }
  const same = JSON.stringify(toActions(rows)) === JSON.stringify((actions || []).map(normalise));
  return { rows, exact: exact && same };
}

/** An edit with only the fields that mean something for its kind. */
function normalise(action) {
  const out = { action: action.action };
  if (action.action !== "Create") out.column = action.column || "";
  if (["Rename", "Copy to", "Create"].includes(action.action)) out.target = action.target || "";
  if (action.action === "Convert") out.to = action.to || "";
  if (["Set value", "Create"].includes(action.action)) {
    out.spec = action.spec || (action.value ? { kind: "SQL", sql: action.value } : null);
  }
  return out;
}

/** The rows as the node's edits, in the fixed order described above. */
export function toActions(rows) {
  const copies = [];
  const values = [];
  const creates = [];
  const converts = [];
  const renames = [];
  const removals = [];
  for (const row of rows) {
    const output = row.output.trim();
    if (row.added && row.input && output) {
      copies.push({ action: "Copy to", column: row.input, target: output });
      if (row.convert) converts.push({ action: "Convert", column: output, to: row.convert });
    } else if (row.added && !row.input && output && row.spec) {
      creates.push({ action: "Create", target: output, spec: clone(row.spec) });
      if (row.convert) converts.push({ action: "Convert", column: output, to: row.convert });
    } else if (!row.added && row.input) {
      if (row.remove) {
        removals.push({ action: "Remove", column: row.input });
        continue;
      }
      if (row.spec) values.push({ action: "Set value", column: row.input, spec: clone(row.spec) });
      // Under the input name: the rename comes after.
      if (row.convert) converts.push({ action: "Convert", column: row.input, to: row.convert });
      if (output && output !== row.input) renames.push({ action: "Rename", column: row.input, target: output });
    }
  }
  return [...copies, ...values, ...creates, ...converts, ...renames, ...removals];
}

/** Output names used twice, which would make the node fail: shown on the rows before OK. */
export function duplicateOutputs(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (row.remove || !row.output.trim()) continue;
    const name = row.output.trim().toLowerCase();
    seen.set(name, (seen.get(name) || 0) + 1);
  }
  return new Set([...seen].filter(([, count]) => count > 1).map(([name]) => name));
}
