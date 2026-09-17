import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/real-ocr", outputDir: "./work/real-ocr-results", workers: 1,
  timeout: 600_000, reporter: "line", retries: 0,
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5175/ocr/", trace: "retain-on-failure",
    launchOptions: { args: ["--enable-unsafe-webgpu", "--use-angle=metal"] } },
  webServer: { command: "OCR_EVALUATION=1 npm run dev -- --host 127.0.0.1 --port 5175 --strictPort", url: "http://127.0.0.1:5175/ocr/", reuseExistingServer: false },
});
