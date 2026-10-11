import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  use: { baseURL: "http://localhost:5199", viewport: { width: 1280, height: 800 } },
  webServer: { command: "npx vite --port 5199", url: "http://localhost:5199", reuseExistingServer: true },
});
