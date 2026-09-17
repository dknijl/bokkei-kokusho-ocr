import { test, expect } from '@playwright/test';

test('v19 runtime preserves Koji, falls back within v19, releases sessions and rejects decoder failures', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { HonkokuRuntime } = await import('/ocr/src/lib/ocr/honkoku/runtime.ts');
    const { DEFAULT_HONKOKU_MANIFEST: manifest } = await import('/ocr/src/lib/ocr/honkoku/default-manifest.ts');
    let released = 0, gpuAttempts = 0, tensorCount = 0, decoderError = false, sequence = 0;
    const tokens = ['<PAD>', '<UNK>', '<CLS>', '<SEP>', '<MASK>', '本文', '<OKURI>', 'ニ', '</OKURI>'];
    const vocab = Array.from({ length: 7710 }, (_, i) => tokens[i] ?? `字${i}`);
    class Tensor {
      constructor(public type: string, public data: any, public dims: number[]) { tensorCount++; }
      dispose() { tensorCount--; }
    }
    const ort = { env: { wasm: {} }, Tensor, InferenceSession: {
      async create(bytes: Uint8Array, options: any) {
        if (options.executionProviders[0] === 'webgpu') { gpuAttempts++; throw new Error('No GPU'); }
        const encoder = bytes[0] < 2;
        return {
          inputNames: encoder ? ['pixel_values'] : ['input_ids', 'encoder_hidden_states', ...Array.from({ length: 24 }, (_, i) => `past_${i}`)],
          outputNames: encoder ? ['hidden'] : ['logits'],
          async run() {
            if (encoder) { sequence = 0; return { hidden: new Tensor('float32', new Float32Array(1), [1]) }; }
            if (decoderError) throw new Error('decoder failed');
            const logits = new Float32Array(7710).fill(-20); logits[[2, 5, 6, 7, 8, 3][sequence++]] = 20;
            return { logits: new Tensor('float32', logits, [1, 1, 7710]),
              ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`present_${i}`, new Tensor('float32', new Float32Array(1), [1])])) };
          }, async release() { released++; },
        };
      },
    } };
    const runtime = new HonkokuRuntime({ loadOrt: async () => ort as any, ensureStorage: async () => {},
      loadAsset: async file => file === manifest.files.vocab ? new TextEncoder().encode(JSON.stringify(vocab))
        : new Uint8Array([file === manifest.files.encoderFp16 || file === manifest.files.encoderInt8 ? 0 : 2]) });
    await runtime.initialize(manifest, true);
    const first = await runtime.recognize(new ImageData(16, 64));
    decoderError = true;
    let error = '';
    try { await runtime.recognize(new ImageData(16, 64)); } catch (failure) { error = String(failure); }
    await runtime.dispose();
    decoderError = false;
    await runtime.initialize(manifest, false);
    const controller = new AbortController(); controller.abort();
    let aborted = false;
    try { await runtime.recognize(new ImageData(16, 64), controller.signal); } catch (failure) { aborted = (failure as Error).name === 'AbortError'; }
    const second = await runtime.recognize(new ImageData(16, 64));
    await runtime.dispose();
    return { first, second, error, aborted, released, gpuAttempts, tensorCount };
  });
  expect(result.first.rawKoji).toBe('本文<OKURI>ニ</OKURI>');
  expect(result.first.text).toBe('本文ニ');
  expect(result.first.stopReason).toBe('eos');
  expect(result.second.rawKoji).toBe(result.first.rawKoji);
  expect(result.aborted).toBe(true);
  expect(result.error).toContain('decoder failed');
  expect(result.gpuAttempts).toBe(1);
  expect(result.released).toBe(6);
  expect(result.tensorCount).toBe(0);
});

test('model cache shares downloads, rehashes cached bytes and rejects changed files', async ({ page }) => {
  let calls = 0;
  await page.route('https://models.example.test/asset', async route => { calls++; await route.fulfill({ body: Buffer.from('model'), contentType: 'application/octet-stream' }); });
  await page.goto('./');
  const output = await page.evaluate(async () => {
    const { loadHonkokuAsset } = await import('/ocr/src/lib/ocr/honkoku/model-cache.ts');
    const { sha256 } = await import('/ocr/src/lib/ocr/honkoku/manifest.ts');
    const file = { url: 'https://models.example.test/asset', bytes: 5, sha256: await sha256(new TextEncoder().encode('model')) };
    await Promise.all([loadHonkokuAsset(file), loadHonkokuAsset(file)]);
    await loadHonkokuAsset(file);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('bokkei-honkoku-models-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('assets', 'readwrite');
      tx.objectStore('assets').put(new TextEncoder().encode('wrong').buffer, `honkoku-v19:${file.url}:${file.sha256}:${file.bytes}`);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
    const repaired = await loadHonkokuAsset(file);
    let integrity = false, size = false;
    try { await loadHonkokuAsset({ ...file, sha256: 'f'.repeat(64) }); } catch (e) { integrity = String(e).includes('SHA-256'); }
    try { await loadHonkokuAsset({ ...file, bytes: 4 }); } catch (e) { size = String(e).includes('byte length'); }
    return { text: new TextDecoder().decode(repaired), integrity, size };
  });
  expect(output).toEqual({ text: 'model', integrity: true, size: true });
  expect(calls).toBe(5);
});

test('page execution uses one worker, verifies the manifest and preserves result identity', async ({ page, context }) => {
  const { DEFAULT_HONKOKU_MANIFEST } = await import('../../src/lib/ocr/honkoku/default-manifest.ts');
  await context.route('https://models.example.test/manifest.json', route => route.fulfill({ json: DEFAULT_HONKOKU_MANIFEST }));
  await context.route('**/src/lib/ndl-ocr.ts*', route => route.fulfill({ contentType: 'application/javascript', body: `
    self.Worker = class { constructor() { throw new Error('Nested Worker is forbidden'); } };
    export async function detectPageLines(page, options) { return { imageWidth: 1, imageHeight: 1,
      detectorRevision: options.modelRevision, options, detections: [{ x: 0, y: 0, width: 1, height: 1, detectionScore: .9 }],
      stats: { modelInferenceCount: 1 } }; }
    export async function releaseNdlOcrModels() {}
  ` }));
  await context.route('**/src/lib/ocr/honkoku/runtime.ts*', route => route.fulfill({ contentType: 'application/javascript', body: `
    export class HonkokuRuntime { provider = 'WASM'; async initialize() {} async dispose() {}
      async recognize() { return { text: '本文ニ', rawKoji: '本文<OKURI>ニ</OKURI>', stopReason: 'eos',
        outputFormat: 'koji', recognizerId: 'honkoku-v19', confidenceKind: 'autoregressive-token' }; } }
  ` }));
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; canvas.getContext('2d')!.fillRect(0, 0, 1, 1); return canvas.toDataURL('image/png').split(',')[1]; });
  await context.route('https://images.example.test/line.png', route => route.fulfill({ contentType: 'image/png',
    body: Buffer.from(png, 'base64') }));
  await page.goto('./');
  const workers: string[] = []; page.on('worker', worker => workers.push(worker.url()));
  const result = await page.evaluate(async () => {
    const { pinPageOcrRequest } = await import('/ocr/src/lib/ocr/engine/pin-request.ts');
    const { executeOcrPage, disposeOcrWorker } = await import('/ocr/src/lib/ocr/worker-client.ts');
    const { normalizeNdlOcrOptions } = await import('/ocr/src/lib/ocr/profiles.ts');
    const pinned = await pinPageOcrRequest({ engineId: 'honkoku-v19', options: normalizeNdlOcrOptions({ modelRevision: 'a'.repeat(40) }) });
    const source = { canvasId: '1', imageServiceId: '', image: 'https://images.example.test/line.png',
      width: 1, height: 1, label: '1', labelTranslations: {}, thumbnail: '', result: [] };
    const result = await executeOcrPage(source, pinned, () => {});
    disposeOcrWorker();
    let rejected = false;
    try { await executeOcrPage(source, { ...pinned, expectedIdentity: { ...pinned.expectedIdentity, modelManifestDigest: 'f'.repeat(64) } }, () => {}); }
    catch (error) { rejected = String(error).includes('manifest changed'); }
    disposeOcrWorker();
    return { result, rejected, expected: pinned.expectedIdentity };
  });
  expect(result.result.identity).toEqual(result.expected);
  expect(result.result.lines[0].rawKoji).toBe('本文<OKURI>ニ</OKURI>');
  expect(result.rejected).toBe(true);
  expect(workers).toHaveLength(2);
  expect(workers.every(url => url.includes('page.worker'))).toBe(true);
});

test('mobile and missing GPU adapter use WASM', async ({ page }) => {
  await page.goto('./');
  const providers = await page.evaluate(async () => {
    const { chooseHonkokuRuntime } = await import('/ocr/src/lib/ocr/models/runtime.ts');
    Object.defineProperty(navigator, 'userAgent', { value: 'Android', configurable: true });
    Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => ({}) }, configurable: true });
    const mobile = await chooseHonkokuRuntime();
    Object.defineProperty(navigator, 'userAgent', { value: 'Desktop', configurable: true });
    Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => null }, configurable: true });
    const unavailable = await chooseHonkokuRuntime();
    Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => ({}) }, configurable: true });
    const desktop = await chooseHonkokuRuntime();
    return { mobile, unavailable, desktop };
  });
  expect(providers).toEqual({ mobile: 'wasm', unavailable: 'wasm', desktop: 'webgpu' });
});
