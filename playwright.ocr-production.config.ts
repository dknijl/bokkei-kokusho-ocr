import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/production", outputDir: "./work/production-results", workers: 1, timeout: 180_000,
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5176/ocr/", trace: "retain-on-failure", launchOptions: { args: ["--enable-unsafe-webgpu", "--use-angle=metal"] } },
  webServer: { command: "npm run preview -- --host 127.0.0.1 --port 5176 --strictPort --outDir dist/client", url: "http://127.0.0.1:5176/ocr/", reuseExistingServer: false },
});
