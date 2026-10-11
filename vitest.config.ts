import { defineConfig } from "vitest/config";

// Unit tests live next to the code; Playwright owns tests/e2e.
export default defineConfig({ test: { include: ["src/**/*.test.ts"], environment: "node" } });
