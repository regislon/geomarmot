import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { catalogue, paramsSchemaFor, searchCatalogue } from "../../app/src/ai/catalogue.js";
import { validate } from "../../app/src/core/jsonschema.js";
import { AGGREGATE_KINDS } from "../../transformers/_kit/value-schemas.js";
import { AGGREGATE_FUNCTIONS, REGISTRY, defaultParams } from "../../transformers/index.js";

const transformerSchema = JSON.parse(readFileSync("schemas/transformer.schema.json", "utf8"));
const problems = (errors) => errors.map((e) => `${e.path} ${e.message}`);

describe("catalogue", () => {
  const entries = catalogue();

  test("covers every palette transformer, and is plain JSON", () => {
    expect(entries).toHaveLength(44);
    expect(JSON.parse(JSON.stringify(entries))).toEqual(entries);
  });

  test("every entry validates against schemas/transformer.schema.json", () => {
    for (const entry of entries) expect(problems(validate(entry, transformerSchema)), entry.id).toEqual([]);
  });

  test("the Reader is not offered to the assistant; the Writer is", () => {
    const usable = new Set(entries.filter((e) => e.aiUsable).map((e) => e.id));
    expect(usable.has("Reader")).toBe(false);
    expect(usable.has("Writer")).toBe(true);
    expect(usable.has("SQLTransformer")).toBe(true);
  });

  test("ports that depend on params are flagged", () => {
    const flagged = entries.filter((e) => e.outputsDependOnParams).map((e) => e.id);
    expect(flagged.sort()).toEqual(["AttributeFilter", "TestFilter"]);
  });
});

describe("params schemas", () => {
  test("every transformer's defaults validate", () => {
    for (const id of catalogue().map((e) => e.id))
      expect(problems(validate(defaultParams(id), paramsSchemaFor(id))), id).toEqual([]);
  });

  test("every fixture case's params validate", () => {
    for (const dir of readdirSync("transformers")) {
      const path = `transformers/${dir}/tests.json`;
      if (dir.startsWith("_") || !existsSync(path)) continue;
      const { transformer, cases } = JSON.parse(readFileSync(path, "utf8"));
      const schema = paramsSchemaFor(transformer);
      for (const c of cases)
        expect(problems(validate(c.params || {}, schema)), `${transformer}: ${c.name}`).toEqual([]);
    }
  });

  test("an unknown param or a wrong option is refused", () => {
    const schema = paramsSchemaFor("Tester");
    expect(validate({ logic: "XOR" }, schema)).not.toEqual([]);
    expect(validate({ sqlMode: "unrestricted" }, schema)).not.toEqual([]);
    expect(validate({ conditions: [{ column: "a", operator: "=", value: "1", extra: 1 }] }, schema)).not.toEqual([]);
  });

  test("the aggregate list is the Aggregator's", () => {
    expect(AGGREGATE_KINDS).toEqual(AGGREGATE_FUNCTIONS);
  });

  test("the registry has no transformer the schemas miss", () => {
    const committed = JSON.parse(readFileSync("schemas/params.schema.json", "utf8"));
    for (const id of catalogue().map((e) => e.id)) expect(committed.$defs[id], id).toBeTruthy();
    expect(REGISTRY.size).toBeGreaterThanOrEqual(44);
  });
});

describe("searchCatalogue", () => {
  const top = (query, n = 3) =>
    searchCatalogue(query)
      .slice(0, n)
      .map((e) => e.id);

  test.each([
    ["points from lon lat columns", "VertexCreator"],
    ["remove duplicate rows", "DuplicateFilter"],
    ["buffer around lines", "Bufferer"],
    ["reproject to another coordinate system", "Reprojector"],
    ["rename columns", "AttributeRenamer"],
    ["h3 cells from polygons", "PolygonToH3"],
  ])("%s finds %s", (query, id) => {
    expect(top(query)).toContain(id);
  });

  test("never offers the Reader or the Writer by default", () => {
    expect(searchCatalogue("read a file write output", { limit: 44 }).map((e) => e.id)).not.toContain("Reader");
  });
});

describe("what the assistant is told about params", () => {
  test("each param carries the exact shape of its value, and composite kinds an example", () => {
    const vertex = catalogue().find((e) => e.id === "VertexCreator");
    const x = vertex.params.find((p) => p.id === "x");
    expect(x.value.type).toBe("object");
    expect(x.value.properties.kind.enum).toEqual(["Value", "Attribute", "Formula", "SQL"]);
    expect(x.example).toEqual({ kind: "Attribute", column: "lon" });
    expect(JSON.stringify(x.value)).not.toContain("$ref");
    expect(
      validate(x.example, paramsSchemaFor("VertexCreator").properties.x, paramsSchemaFor("VertexCreator")),
    ).toEqual([]);
  });

  test("every example validates against its own param's schema", () => {
    for (const entry of catalogue()) {
      const schema = paramsSchemaFor(entry.id);
      for (const p of entry.params.filter((p) => p.example !== undefined)) {
        expect(validate({ [p.id]: p.example }, schema), `${entry.id}.${p.id}`).toEqual([]);
      }
    }
  });
});
