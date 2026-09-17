import { test, expect } from '@playwright/test';
import { DEFAULT_HONKOKU_MANIFEST } from '../../src/lib/ocr/honkoku/default-manifest.ts';
import { HONKOKU_V19_UPSTREAM_COMMIT } from '../../src/lib/ocr/honkoku/manifest.ts';
const modelManifestUrl = process.env.VITE_HONKOKU_MODEL_MANIFEST_URL?.trim() ?? '';
const bundled = process.env.HONKOKU_SMOKE_BUNDLED_MANIFEST === '1';
const smokeIiifManifestUrl = process.env.HONKOKU_SMOKE_IIIF_MANIFEST_URL ?? '';
test('v19 page worker recognizes with pinned identity and reuses the verified model cache', async ({ page, context, request }) => {
  test.skip(process.env.VITE_ENABLE_HONKOKU !== 'true' || !modelManifestUrl, 'Requires enabled Honkoku and HTTPS manifest URL.');
  test.setTimeout(600_000);
  const manifest = bundled ? DEFAULT_HONKOKU_MANIFEST : await (await request.get(modelManifestUrl)).json();
  expect(manifest.engineId).toBe('honkoku-v19');
  expect(manifest.upstreamCommit).toBe(HONKOKU_V19_UPSTREAM_COMMIT);
  if (bundled) await context.route(modelManifestUrl, route => route.fulfill({ json: manifest }));
  const modelUrls = new Set(Object.values(manifest.files).map((file: any) => file.url));
  const requests: string[] = [];
  context.on('request', event => { if (modelUrls.has(event.url())) requests.push(event.url()); });
  await page.goto('./');
  const first = await page.evaluate(async ({ modelManifestUrl, smokeIiifManifestUrl }) => {
    const { initialManifest, parseManifest } = await import('/ocr/src/lib/iiif.ts');
    const { pinPageOcrRequest } = await import('/ocr/src/lib/ocr/engine/pin-request.ts');
    const { executeOcrPage, disposeOcrWorker } = await import('/ocr/src/lib/ocr/worker-client.ts');
    const { DEFAULT_NDL_OCR_OPTIONS } = await import('/ocr/src/lib/ocr/profiles.ts');
    const url = smokeIiifManifestUrl || initialManifest.url;
    const response = await fetch(url); if (!response.ok) throw new Error(`IIIF HTTP ${response.status}`);
    const source = parseManifest(await response.json(), url).pages[0];
    const pinned = await pinPageOcrRequest({ engineId: 'honkoku-v19', options: DEFAULT_NDL_OCR_OPTIONS, modelManifestUrl });
    const result = await executeOcrPage(source, pinned, () => {});
    disposeOcrWorker();
    (window as any).smokeInput = { source, pinned };
    return result;
  }, { modelManifestUrl, smokeIiifManifestUrl });
  expect(first.identity.engineId).toBe('honkoku-v19');
  expect(first.lines.length).toBeGreaterThan(0);
  expect(first.lines.every(line => line.rawKoji !== undefined)).toBe(true);
  const firstDownloads = requests.length;
  const second = await page.evaluate(async () => {
    const { executeOcrPage, disposeOcrWorker } = await import('/ocr/src/lib/ocr/worker-client.ts');
    const { source, pinned } = (window as any).smokeInput;
    const result = await executeOcrPage(source, pinned, () => {}); disposeOcrWorker();
    return result;
  });
  expect(second.identity).toEqual(first.identity);
  expect(requests.length).toBe(firstDownloads);
  console.log('HONKOKU_PAGE_SMOKE', JSON.stringify({ provider: first.provider, lines: first.lines.length,
    firstMs: first.stats.durationMs, cachedMs: second.stats.durationMs, firstModelRequests: firstDownloads,
    cachedModelRequests: requests.length - firstDownloads, identity: first.identity }));
});
