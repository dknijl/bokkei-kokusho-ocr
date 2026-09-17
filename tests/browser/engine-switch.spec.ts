import { test, expect } from '@playwright/test';
test('default startup enables Honkoku and restores its saved selection without model downloads', async ({ page }) => {
  const downloads: string[] = [];
  page.on('request', request => { if (/\.onnx(?:$|\?)/.test(request.url())) downloads.push(request.url()); });
  await page.addInitScript(() => { localStorage.setItem('bokkei-service-notice-accepted', 'true'); localStorage.setItem('bokkei-ocr-engine', 'honkoku-v19'); });
  await page.goto('./');
  await expect(page.locator('#ocr-engine')).toHaveValue('honkoku-v19');
  await expect(page.locator('#ocr-engine option[value="honkoku-v19"]')).toHaveJSProperty('disabled', false);
  await expect(page.locator('.ocr-engine-unavailable')).toHaveCount(0);
  expect(downloads).toEqual([]);
});
