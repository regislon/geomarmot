// @ts-check
import { defineTransformer, API_VERSION, param, qid } from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "FeatureJoiner",
  group: "Combine",
  summary: "Joins two streams on matching attributes, with the unmatched rows on their own ports.",
  description:
    "FeatureJoiner matches rows from the Left and Right inputs on one or more pairs of attributes and " +
    "writes the combined rows to Joined; rows of either side that found no partner come out of Unjoined L " +
    "and Unjoined R. The join type decides what Joined holds: Inner keeps matches only, Left keeps every " +
    "left row, Full keeps every row of both. Right-side join keys are dropped, since they equal the left " +
    "ones, and any other right attribute whose name the left already has gets a suffix, so no two columns " +
    "share a name. It joins on attribute values, not on geometry: it is not a spatial join.",
  whenToUse: [
    "attach an owner table to plots by plot id",
    "find the plots that have no owner (Unjoined L)",
    "merge two tables that share a key",
  ],
  whenNotToUse: [
    "stacking two streams with the same attributes — use Unioner",
    "joining by location — write the spatial predicate in an SQLTransformer",
  ],
  keywords: ["join", "merge", "lookup", "match", "combine", "relate", "feature merger", "left join"],
  examples: [
    {
      input: "left id 1,2,3; right key 1,3,4",
      params: "Inner, id = key",
      output: "Joined: 1 and 3; Unjoined L: 2; Unjoined R: 4",
    },
  ],
  inputs: [
    { id: "left", label: "Left", description: "The rows to enrich; their attributes come first and keep their names." },
    {
      id: "right",
      label: "Right",
      description: "The rows to match against; their join keys are dropped from the result.",
    },
  ],
  outputs: [
    {
      id: "joined",
      label: "Joined",
      description: "Matched rows (and, for Left or Full joins, the unmatched ones with NULLs).",
    },
    { id: "unjoinedLeft", label: "Unjoined L", description: "Left rows that matched no right row." },
    { id: "unjoinedRight", label: "Unjoined R", description: "Right rows that matched no left row." },
  ],
  params: [
    param.select("joinType", "Join", {
      options: [
        { value: "Inner", description: "Joined holds matched rows only." },
        { value: "Left", description: "Joined keeps every left row, with NULLs where nothing matched." },
        { value: "Full", description: "Joined keeps every row of both sides." },
      ],
      default: "Inner",
      description: "Which rows the Joined port keeps when a row finds no partner on the other side.",
    }),
    param.joinkeys("keys", "Join on", {
      description: "Pairs of left and right attributes that must be equal for two rows to match.",
    }),
    param.string("suffix", "Suffix for clashing right attributes", {
      default: "_right",
      description: "Appended to a right attribute whose name the left side already has, so both can be kept.",
    }),
  ],
  needs: { schema: true },
  sql: (ctx) => {
    const pairs = (ctx.params.keys || []).filter((pair) => pair.left && pair.right);
    if (!pairs.length) throw new Error("FeatureJoiner needs at least one pair of join attributes.");
    const { left, right } = ctx.inputs;
    const condition = pairs.map((pair) => `l.${qid(pair.left)} = r.${qid(pair.right)}`).join(" AND ");
    const rightKeys = new Set(pairs.map((pair) => pair.right));
    const leftNames = new Set((ctx.schemas?.left || []).map((column) => column.name));
    const suffix = ctx.params.suffix || "_right";
    const rightSelection = (ctx.schemas?.right || [])
      .filter((column) => !rightKeys.has(column.name))
      .map((column) =>
        leftNames.has(column.name) ? `r.${qid(column.name)} AS ${qid(column.name + suffix)}` : `r.${qid(column.name)}`,
      );
    const joinWord = { Inner: "INNER JOIN", Left: "LEFT JOIN", Full: "FULL JOIN" }[ctx.params.joinType || "Inner"];
    return {
      joined: `SELECT ${["l.*", ...rightSelection].join(", ")} FROM ${left} l ${joinWord} ${right} r ON ${condition}`,
      unjoinedLeft: `SELECT l.* FROM ${left} l LEFT JOIN ${right} r ON ${condition} WHERE r.${qid(pairs[0].right)} IS NULL`,
      unjoinedRight: `SELECT r.* FROM ${right} r LEFT JOIN ${left} l ON ${condition} WHERE l.${qid(pairs[0].left)} IS NULL`,
    };
  },
});
