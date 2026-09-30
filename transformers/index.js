/*
 * The transformer registry: every transformer the app knows, by id.
 *
 * Native transformers are imported one per line below (one line per folder,
 * alphabetical within a group) — adding a transformer is a one-line change here.
 * Entries still in legacy.js are presented through the kit's legacy adapter
 * until their group moves into folders.
 */

import { defaultParamValues } from "./_kit/index.js";
import { adaptLegacy } from "./_kit/legacy-adapter.js";
import { TRANSFORMERS as LEGACY } from "./legacy.js";

// Source
import Reader from "./reader/index.js";
// Output
import Writer from "./writer/index.js";

// Attributes
import AttributeCreator from "./attribute-creator/index.js";
import AttributeKeeper from "./attribute-keeper/index.js";
import AttributeManager from "./attribute-manager/index.js";
import AttributeRemover from "./attribute-remover/index.js";
import AttributeRenamer from "./attribute-renamer/index.js";

const NATIVE = [
  AttributeManager,
  AttributeCreator,
  AttributeRenamer,
  AttributeRemover,
  AttributeKeeper,
  Reader,
  Writer,
];

/** id -> transformer definition. */
export const REGISTRY = new Map();
const ALIASES = new Map();

function add(definition) {
  if (REGISTRY.has(definition.id)) throw new Error(`Two transformers are called ${definition.id}.`);
  REGISTRY.set(definition.id, definition);
  for (const alias of definition.aliases) ALIASES.set(alias, definition.id);
}

for (const definition of NATIVE) add(definition);
for (const [type, entry] of Object.entries(LEGACY)) if (!REGISTRY.has(type)) add(adaptLegacy(type, entry));

/** Transformer types grouped for the palette, in a deliberate order. */
export const PALETTE_GROUPS = [
  "Source",
  "Attributes",
  "Filters",
  "Combine",
  "Reshape",
  "Geometry",
  "Analysis",
  "H3",
  "Output",
];

/**
 * Score a transformer name against a typed fragment, for Quick Add.
 *
 * The letters have to appear in order but need not be adjacent, which is what
 * makes "tefi" find AttributeFilter (attribu-TE-FI-lter) and "sam" find
 * Sampler. Runs and capital letters score higher, so a fragment that lines up
 * with the start of a word beats the same letters scattered through a longer
 * name. Returns -1 when the fragment does not appear at all.
 */
export function fuzzyScore(query, name) {
  const needle = query.toLowerCase();
  const hay = name.toLowerCase();
  if (!needle) return 0;

  // Best score for matching needle[0..i] with needle[i] landing on hay[j].
  //
  // A search over every alignment rather than taking the first letter that
  // fits: "tefi" against AttributeFilter must use the t at index 7 to land on
  // the contiguous "tefi", and a greedy scan would take the t at index 1 and
  // score the real match a third lower than DuplicateFilter's.
  let previousRow = null;
  for (let i = 0; i < needle.length; i++) {
    const row = new Array(hay.length).fill(-Infinity);
    let bestBefore = -Infinity; // best previousRow value strictly left of j
    let bestBeforeExcludingAdjacent = -Infinity;
    for (let j = 0; j < hay.length; j++) {
      if (j > 0 && previousRow) {
        bestBeforeExcludingAdjacent = bestBefore;
        bestBefore = Math.max(bestBefore, previousRow[j - 1]);
      }
      if (hay[j] !== needle[i]) continue;
      const boundary = j === 0 || /[A-Z]/.test(name[j]) ? 10 : 0;
      if (i === 0) {
        row[j] = 10 + boundary;
        continue;
      }
      const adjacent = previousRow[j - 1] > -Infinity ? previousRow[j - 1] + 12 : -Infinity;
      const anywhere = Math.max(bestBeforeExcludingAdjacent, adjacent);
      if (anywhere > -Infinity) row[j] = anywhere + 10 + boundary;
    }
    previousRow = row;
  }

  const best = Math.max(...previousRow);
  if (best === -Infinity) return -1;
  // Among equally good matches, prefer the shorter name.
  return best - name.length * 0.2;
}

/** Transformer ids matching a typed fragment, best first; test-only types are never offered. */
export function searchTransformers(query) {
  const names = [...REGISTRY.keys()].filter((id) => REGISTRY.get(id).group !== "Test");
  if (!query.trim()) return names;
  return names
    .map((name) => ({ name, score: fuzzyScore(query.trim(), name) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((entry) => entry.name);
}

/** The definition for a type, following aliases; throws for an unknown type. */
export function transformerFor(type) {
  const transformer = REGISTRY.get(type) || REGISTRY.get(ALIASES.get(type));
  if (!transformer) throw new Error(`Unknown transformer type "${type}"`);
  return transformer;
}

/** The current id for a type saved under an older name, or the type itself. */
export function canonicalType(type) {
  return REGISTRY.has(type) ? type : ALIASES.get(type) || type;
}

/** Default parameter object for a freshly dropped node. */
export function defaultParams(type) {
  return defaultParamValues(transformerFor(type).params);
}

/** Register a transformer outside the palette, for the test harness only. */
export function registerForTests(definition) {
  REGISTRY.set(definition.id, definition);
}

export { OPERATORS } from "./_kit/index.js";
export { AGGREGATE_FUNCTIONS } from "./legacy.js";
