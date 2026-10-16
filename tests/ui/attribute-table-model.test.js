import { describe, expect, test } from "vitest";
import { duplicateOutputs, rowAction, toActions, toRows } from "../../app/src/ui/inspector/attribute-table-model.js";

const COLUMNS = [
  { name: "id", type: "INTEGER" },
  { name: "name", type: "VARCHAR" },
  { name: "v", type: "DOUBLE" },
];
const value = (text) => ({ kind: "Value", type: "Text", value: text });

describe("AttributeManager's table", () => {
  test("no edits: one row per input attribute, each doing nothing", () => {
    const { rows, exact } = toRows([], COLUMNS);
    expect(rows.map((row) => [row.input, row.output, row.type, rowAction(row)])).toEqual([
      ["id", "id", "INTEGER", "Do nothing"],
      ["name", "name", "VARCHAR", "Do nothing"],
      ["v", "v", "DOUBLE", "Do nothing"],
    ]);
    expect(exact).toBe(true);
    expect(toActions(rows)).toEqual([]);
  });

  test("edits in table order come back exactly, row by row", () => {
    const actions = [
      { action: "Copy to", column: "name", target: "name_copy" },
      { action: "Set value", column: "v", spec: value("x") },
      { action: "Create", target: "flag", spec: value("yes") },
      { action: "Rename", column: "v", target: "w" },
      { action: "Remove", column: "id" },
    ];
    const { rows, exact } = toRows(actions, COLUMNS);
    expect(exact).toBe(true);
    expect(rows.map(rowAction)).toEqual(["Remove", "Do nothing", "Rename and set value", "Copy", "Create"]);
    expect(toActions(rows)).toEqual(actions);
  });

  test("a list in another order is flagged before it is rewritten", () => {
    // Rename, then set the new name: the table shows both on v's row, and says it will reorder.
    const actions = [
      { action: "Rename", column: "v", target: "w" },
      { action: "Set value", column: "w", spec: value("x") },
    ];
    const { rows, exact } = toRows(actions, COLUMNS);
    expect(exact).toBe(false);
    expect(rowAction(rows[2])).toBe("Rename and set value");
    expect(toActions(rows)).toEqual([
      { action: "Set value", column: "v", spec: value("x") },
      { action: "Rename", column: "v", target: "w" },
    ]);
  });

  test("a conversion sits on its row, and is saved under the input name before a rename", () => {
    const actions = [
      { action: "Convert", column: "v", to: "Integer" },
      { action: "Rename", column: "v", target: "w" },
    ];
    const { rows, exact } = toRows(actions, COLUMNS);
    expect(exact).toBe(true);
    expect(rows[2].convert).toBe("Integer");
    expect(rowAction(rows[2])).toBe("Rename");
    rows[0].convert = "Text";
    expect(rowAction(rows[0])).toBe("Convert");
    expect(toActions(rows)).toEqual([
      { action: "Convert", column: "id", to: "Text" },
      { action: "Convert", column: "v", to: "Integer" },
      { action: "Rename", column: "v", target: "w" },
    ]);
  });

  test("a copy is converted under its new name; the original keeps its type", () => {
    const { rows } = toRows([{ action: "Copy to", column: "v", target: "v_int" }], COLUMNS);
    rows[3].convert = "Integer";
    expect(toActions(rows)).toEqual([
      { action: "Copy to", column: "v", target: "v_int" },
      { action: "Convert", column: "v_int", to: "Integer" },
    ]);
  });

  test("the old raw-SQL value field reads as a SQL value", () => {
    const { rows } = toRows([{ action: "Set value", column: "v", value: "v * 2" }], COLUMNS);
    expect(rows[2].spec).toEqual({ kind: "SQL", sql: "v * 2" });
  });

  test("an edit on an attribute that is not there is dropped, and flagged", () => {
    const { rows, exact } = toRows([{ action: "Remove", column: "gone" }], COLUMNS);
    expect(exact).toBe(false);
    expect(toActions(rows)).toEqual([]);
  });

  test("two attributes with one output name are caught, case aside", () => {
    const { rows } = toRows([{ action: "Rename", column: "v", target: "NAME" }], COLUMNS);
    expect(duplicateOutputs(rows)).toEqual(new Set(["name"]));
    rows[1].remove = true;
    expect(duplicateOutputs(rows).size).toBe(0);
  });
});
