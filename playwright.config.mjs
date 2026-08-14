import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  outputDir: "test-results",
  timeout: 15_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
});
