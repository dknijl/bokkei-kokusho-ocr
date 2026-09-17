import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/model-smoke', outputDir: './work/model-smoke-results', workers: 1,
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:5178/ocr/' },
  webServer: { command: 'OCR_EVALUATION=1 npm run dev -- --host 127.0.0.1 --port 5178 --strictPort', url: 'http://127.0.0.1:5178/ocr/', reuseExistingServer: false },
});
