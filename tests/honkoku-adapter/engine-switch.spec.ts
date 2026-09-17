import { test, expect, type Page } from '@playwright/test';
import { DEFAULT_HONKOKU_MANIFEST } from '../../src/lib/ocr/honkoku/default-manifest';
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bokkei-service-notice-accepted', 'true'));
  await page.route('https://models.example.test/manifest.json', r => r.fulfill({ json: DEFAULT_HONKOKU_MANIFEST }));
});
const revision = 'a'.repeat(40);
async function expectScoreFits(page: Page) {
  const ring = (await page.locator('.confidence-ring').boundingBox())!;
  const value = (await page.locator('.confidence-ring strong').boundingBox())!;
  const label = (await page.locator('.confidence-ring small').boundingBox())!;
  const heading = (await page.locator('.panel-head > div').first().boundingBox())!;
  const summary = (await page.locator('.score-summary').boundingBox())!;
  const panel = (await page.locator('.panel-head').boundingBox())!;
  expect(value.y + value.height + 3).toBeLessThanOrEqual(label.y);
  for (const content of [value, label]) {
    expect(content.x).toBeGreaterThan(ring.x + 3);
    expect(content.x + content.width).toBeLessThan(ring.x + ring.width - 3);
    expect(content.y).toBeGreaterThan(ring.y + 3);
    expect(content.y + content.height).toBeLessThan(ring.y + ring.height - 3);
    expect(Math.abs(content.x + content.width / 2 - ring.x - ring.width / 2)).toBeLessThan(1);
  }
  expect(heading.x + heading.width + 8).toBeLessThanOrEqual(summary.x);
  expect(summary.x + summary.width).toBeLessThan(panel.x + panel.width);
}

test('without environment settings, model selector enables Honkoku and persists the choice', async ({ page }) => {
  await page.goto('./');
  const selector = page.locator('#ocr-engine');
  await expect(selector).toHaveValue('ndl-parseq');
  await expect(selector.locator('option[value="honkoku-v19"]')).toHaveJSProperty('disabled', false);
  await selector.selectOption('honkoku-v19');
  await expect(selector).toHaveValue('honkoku-v19');
  await page.reload();
  await expect(selector).toHaveValue('honkoku-v19');
  await selector.selectOption('ndl-parseq');
  await expect(selector).toHaveValue('ndl-parseq');
});

test('selected Honkoku request reaches Worker; result provenance stays pinned; abort terminates', async ({ page }) => {
  await page.route('https://api.github.com/repos/ndl-lab/ndlkotenocr-lite/commits/master', (route) => route.fulfill({ json: { sha: revision } }));
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    (window as any).honkokuRequests = []; (window as any).terminated = 0;
    window.Worker = class extends EventTarget {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(); if (!String(url).includes('page.worker')) return new NativeWorker(url, options) as any;
      }
      onmessage: ((event: MessageEvent) => void) | null = null;
      postMessage(value: any) {
        (window as any).honkokuRequests.push(value.request);
        if ((window as any).holdHonkoku) return;
        setTimeout(() => this.onmessage?.(new MessageEvent('message', { data: {
          id: value.id, type: 'result', result: {
            identity: value.request.expectedIdentity, revision: value.request.expectedIdentity.recognizerRevision,
            pipelineVersion: value.request.expectedIdentity.pipelineVersion, provider: 'WASM',
            profile: value.request.options.profile, options: value.request.options, imageWidth: 100, imageHeight: 100,
            lines: [{ text: '翻刻結果', rawKoji: '翻刻<OKURI>ニ</OKURI>', detectionScore: 0.9,
              confidenceKind: 'autoregressive-token', stopReason: 'eos', recognizerId: 'honkoku-v19',
              meanLogProbability: Math.log((window as any).scoreProbability ?? 0.835), generatedTokens: 8 }], stats: {},
          },
        } })), 300);
      }
      terminate() { (window as any).terminated++; }
    } as any;
  });
  await page.goto('./');
  await expectScoreFits(page);
  await page.locator('.panel-head').screenshot({ path: 'work/honkoku-adapter-results/score-empty.png' });
  await page.locator('#ocr-engine').selectOption('honkoku-v19');
  await page.locator('.run-full-ocr').click();
  await expect(page.locator('#ocr-engine')).toBeDisabled();
  await expect(page.locator('.analysis-card')).toContainText('みんなで翻刻OCR v19 · 24469701');
  await expect(page.locator('.confidence-ring')).toHaveAttribute('aria-label', '生成スコア: 83.5 / 100');
  await expect(page.locator('.vertical-text button[data-line-index="0"] small')).toContainText('生成 83.5');
  await expect(page.locator('.demo-note')).toContainText('正解率ではなく');
  await expectScoreFits(page);
  await page.locator('.panel-head').screenshot({ path: 'work/honkoku-adapter-results/score-decimal-desktop.png' });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('.narrow-pane-switcher button').nth(1).click();
    await expectScoreFits(page);
    await page.locator('.panel-head').screenshot({ path: `work/honkoku-adapter-results/score-decimal-${width}.png` });
  }
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await expectScoreFits(page);
  await page.locator('.panel-head').screenshot({ path: 'work/honkoku-adapter-results/score-decimal-zoom200.png' });
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await page.setViewportSize({ width: 1280, height: 720 });

  expect(await page.evaluate(() => (window as any).honkokuRequests[0].engineId)).toBe('honkoku-v19');
  expect(await page.evaluate(() => (window as any).honkokuRequests[0].modelManifestUrl)).toBeUndefined();
  await page.locator('#ocr-engine').selectOption('ndl-parseq');
  await expect(page.locator('.analysis-card')).toContainText('みんなで翻刻OCR v19 · 24469701');
  await expect(page.locator('.confidence-ring')).toHaveAttribute('aria-label', '生成スコア: 83.5 / 100');
  expect(await page.evaluate(() => (window as any).terminated)).toBeGreaterThan(0);
  await page.locator('#ocr-engine').selectOption('honkoku-v19');
  await page.evaluate(() => { (window as any).scoreProbability = 1; });
  await page.locator('.run-full-ocr').click();
  await expect(page.locator('.confidence-ring strong')).toHaveText('100');
  await expectScoreFits(page);
  await page.locator('.panel-head').screenshot({ path: 'work/honkoku-adapter-results/score-max.png' });
  await page.evaluate(() => { (window as any).holdHonkoku = true; });
  await page.locator('.run-full-ocr').click();
  await expect(page.locator('.cancel-ocr')).toBeVisible();
  await page.locator('.cancel-ocr').click();
  await expect(page.locator('#ocr-engine')).toBeEnabled();
  expect(await page.evaluate(() => (window as any).terminated)).toBeGreaterThan(1);
});
