// @ts-check
/*
 * The forbidden-terms gate: tokenising, hashing and matching.
 *
 * The deny-list is committed only as salted SHA-256 hashes, so the gate can
 * scan the whole repository — its own files included — without the list
 * itself mentioning anything it forbids. See docs/decisions/0006-terms-gate.md.
 */

import { createHash } from "node:crypto";

/** Hash one normalised token with the list's salt. */
export function hashToken(salt, token) {
  return createHash("sha256").update(`${salt}:${token}`).digest("hex");
}

/**
 * Split text into lowercase pieces, and the runs they came from.
 *
 * Order matters: case boundaries are split while the original case is still
 * there, and only then lowercased. NFKC first folds full-width and other
 * compatibility forms onto plain letters without touching their case.
 *
 * @param {string} text
 * @returns {{ pieces: string[], runs: string[] }}
 */
export function tokenize(text) {
  const pieces = [];
  const runs = [];
  const normalised = text.normalize("NFKC");
  for (const run of normalised.split(/[^\p{L}\p{N}]+/u)) {
    if (!run) continue;
    runs.push(run.toLowerCase());
    const split = run
      // "HTTPServer" -> "HTTP Server", then "aB" -> "a B"
      .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
      .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
      // letter/digit boundaries both ways
      .replace(/(\p{L})(\p{N})/gu, "$1 $2")
      .replace(/(\p{N})(\p{L})/gu, "$1 $2");
    for (const piece of split.split(" ")) if (piece) pieces.push(piece.toLowerCase());
  }
  return { pieces, runs };
}

/**
 * Every candidate string worth hashing for one text: each piece, each whole
 * run, and each concatenation of 2 or 3 adjacent pieces — so "Acme Widgets",
 * "acme-widgets", "AcmeWidgets" and "acmewidgets" all produce the same candidate.
 */
export function candidates(text) {
  const { pieces, runs } = tokenize(text);
  const out = new Set(runs);
  for (let i = 0; i < pieces.length; i++) {
    out.add(pieces[i]);
    if (i + 1 < pieces.length) out.add(pieces[i] + pieces[i + 1]);
    if (i + 2 < pieces.length) out.add(pieces[i] + pieces[i + 1] + pieces[i + 2]);
  }
  return out;
}

/** Normalise one plaintext deny-list entry to the form candidates() produces. */
export function normaliseTerm(term) {
  return tokenize(term).pieces.join("");
}

/** Parse a hash file: first line `salt <value>`, then one hash per line. */
export function parseHashFile(content) {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const first = lines.shift() || "";
  const match = first.match(/^salt\s+(\S+)$/);
  if (!match) throw new Error("Hash file must start with a `salt <value>` line.");
  return { salt: match[1], hashes: new Set(lines) };
}

/** Build a hash file's content from a salt and plaintext terms. */
export function buildHashFile(salt, terms) {
  const hashes = [
    ...new Set(
      terms
        .map(normaliseTerm)
        .filter(Boolean)
        .map((t) => hashToken(salt, t)),
    ),
  ].sort();
  return [
    "# Forbidden terms, as salted SHA-256 hashes. Regenerate with `node scripts/check-terms.js --hash`.",
    `salt ${salt}`,
    ...hashes,
    "",
  ].join("\n");
}

/**
 * Scan one text; return the matching lines (1-based) and the offending
 * candidate for each. The candidate is reported so a maintainer with the
 * plaintext list can see what matched; it is the text's own content.
 *
 * @param {string} text
 * @param {{ salt: string, hashes: Set<string> }} list
 */
export function scanText(text, list) {
  const hits = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const candidate of candidates(lines[i])) {
      if (list.hashes.has(hashToken(list.salt, candidate))) hits.push({ line: i + 1, match: candidate });
    }
  }
  return hits;
}

/** Heuristic: a buffer holding a NUL byte in its first 8 KB is binary. */
export function isBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}
