import { test, expect } from '@playwright/test';
// Vite may reload once when the WASM dynamic import is optimized on first use.
test.describe.configure({ retries: 1 });
test('real v19 WASM encoder and decoder recognize publisher sample', async ({ page }) => {
  test.skip(process.env.HONKOKU_REAL_SMOKE !== '1', 'Manual real-model smoke (~155MB download).');
  test.setTimeout(540000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { HonkokuRuntime } = await import('/ocr/src/lib/ocr/honkoku/runtime.ts');
    const { DEFAULT_HONKOKU_MANIFEST } = await import('/ocr/src/lib/ocr/honkoku/default-manifest.ts');
    const runtime = new HonkokuRuntime();
    await runtime.initialize(DEFAULT_HONKOKU_MANIFEST, false);
    try {
      const url = 'https://huggingface.co/yuta1984/honkoku-ocr/resolve/b0bc83884980826b884a2cfde5ca4275b7d911db/examples/sample_data/images/line_0000.jpg';
      const response = await fetch(url); if (!response.ok) throw new Error(`Sample image HTTP ${response.status}`);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
      try { return await runtime.recognize(ctx.getImageData(0, 0, canvas.width, canvas.height)); }
      finally { canvas.width = canvas.height = 0; }
    } finally { await runtime.dispose(); }
  });
  console.log('REAL_HONKOKU_RESULT', JSON.stringify(result));
  expect(errors).toEqual([]);
  expect(result.recognizerId).toBe('honkoku-v19');
  expect(result.rawKoji?.length).toBeGreaterThan(0);
  expect(result.text.length).toBeGreaterThan(0);
});
