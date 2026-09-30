import { defineConfig } from "vitest/config";

// The meta checks (check:docs, check:fixtures) import the transformer folders.
export default defineConfig({ test: { include: ["tests/meta/*.check.js"], reporters: ["dot"] } });
