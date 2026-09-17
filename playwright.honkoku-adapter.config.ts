import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/honkoku-adapter", outputDir: "./work/honkoku-adapter-results", workers: 1,
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5177/ocr/", trace: "retain-on-failure" },
  webServer: {
    command: "env -u VITE_ENABLE_HONKOKU -u VITE_HONKOKU_MODEL_MANIFEST_URL npm run dev -- --host 127.0.0.1 --port 5177 --strictPort",
    url: "http://127.0.0.1:5177/ocr/", reuseExistingServer: false,
  },
});
