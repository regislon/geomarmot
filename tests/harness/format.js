/*
 * Compact, stable JSON for fixture files: one row per line, one column per
 * line, so a 50-row case stays readable in review and well under 50 KB.
 */

const isScalar = (v) => v === null || typeof v !== "object";
const inlineable = (v) =>
  (Array.isArray(v) && v.every(isScalar)) ||
  (v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.values(v).every(isScalar) &&
    JSON.stringify(v).length <= 100);

function format(value, indent) {
  if (isScalar(value)) return JSON.stringify(value);
  if (inlineable(value)) {
    if (Array.isArray(value)) return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
    const entries = Object.entries(value);
    return entries.length
      ? `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`
      : "{}";
  }
  const pad = "  ".repeat(indent + 1);
  const end = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((v) => pad + format(v, indent + 1)).join(",\n")}\n${end}]`;
  }
  const entries = Object.entries(value);
  if (!entries.length) return "{}";
  return `{\n${entries.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${format(v, indent + 1)}`).join(",\n")}\n${end}}`;
}

export function formatFixture(value) {
  return format(value, 0) + "\n";
}
