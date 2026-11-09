import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.js",
  timeout: 240_000,
  workers: 1,
  use: { browserName: "chromium", baseURL: "http://localhost:5182" },
  webServer: {
    command: "npm run preview -- --port 5182 --strictPort",
    port: 5182,
    reuseExistingServer: true,
  },
});
