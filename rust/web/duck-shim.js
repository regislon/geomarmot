// The GEOS overlay module imports only `qlit` from the app's duck.js; this keeps the app's own
// DuckDB-Wasm build (an older version) out of the page.
export function qlit(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
