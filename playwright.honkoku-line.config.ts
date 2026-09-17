import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', testMatch: 'honkoku-real.spec.ts', outputDir: './work/honkoku-line-results', workers: 1,
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:5179/ocr/' },
  webServer: { command: 'OCR_EVALUATION=1 npm run dev -- --host 127.0.0.1 --port 5179 --strictPort', url: 'http://127.0.0.1:5179/ocr/', reuseExistingServer: false },
});
