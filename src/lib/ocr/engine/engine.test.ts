import { honkokuEnabled } from './registry.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildHonkokuManifest } from '../../../../scripts/build-honkoku-manifest.mjs';
import { ndlModelAssetUrls, requireModelRevision, resolveLatestNdlModelRevision } from './ndl-revision.ts';
import { ndlExecutionIdentity, pinPageOcrRequest, validatePinnedPageOcrRequest, verifyPinnedHonkokuManifest } from './pin-request.ts';
import { pageOcrCacheKey } from './cache-identity.ts';
import { confidencePresentation, recognitionAveragePercent, generationScore, generationAverageScore } from '../confidence-presentation.ts';
import { normalizeNdlOcrOptions } from '../profiles.ts';
import { createOcrBenchmarkRecord, ocrLinesFingerprint, ocrBenchmarkDeterministicFingerprint, serializeBenchmarkCsv } from '../benchmark.ts';
import { applyOcrResult } from '../../viewer-state.ts';
import type { ViewerManifest, ViewerPage } from '../../iiif.ts';
import type { PageOcrResult, PinnedPageOcrRequest } from './types.ts';
import {
  HONKOKU_FILE_NAMES, HONKOKU_RUNTIME, HONKOKU_UPSTREAM_REPOSITORY, HONKOKU_V19_UPSTREAM_COMMIT,
  validateHonkokuManifest, honkokuManifestDigest, fetchHonkokuManifest, totalHonkokuModelBytes,
} from '../honkoku/manifest.ts';

const revision = 'a'.repeat(40);
const base = `https://example.test/honkoku/v19/${HONKOKU_V19_UPSTREAM_COMMIT}/`;
function fixture() {
  return {
    schemaVersion: 2, engineId: 'honkoku-v19', modelVersion: 'v19',
    upstreamRepository: String(HONKOKU_UPSTREAM_REPOSITORY), upstreamCommit: String(HONKOKU_V19_UPSTREAM_COMMIT),
    license: 'CC-BY-4.0', runtime: Object.fromEntries(Object.entries(HONKOKU_RUNTIME)) as Record<keyof typeof HONKOKU_RUNTIME, number>,
    files: Object.fromEntries(Object.entries(HONKOKU_FILE_NAMES).map(([role, name]) =>
      [role, { url: String(name), sha256: 'a'.repeat(64), bytes: 123 }])),
  };
}
function page(): ViewerPage {
  return { canvasId: 'canvas', imageServiceId: 'https://example.test/image', label: '1', labelTranslations: {},
    image: 'https://example.test/image.jpg', thumbnail: '', width: 200, height: 400, result: [] };
}

test('manifest validates v19, resolves URLs, and hashes canonical content', async () => {
  const manifest = validateHonkokuManifest(fixture(), base + 'manifest.json');
  assert.equal(totalHonkokuModelBytes(manifest), 615);
  assert.equal(manifest.files.vocab.url, base + HONKOKU_FILE_NAMES.vocab);
  const reordered = Object.fromEntries(Object.entries(manifest).reverse());
  assert.equal(await honkokuManifestDigest(manifest), await honkokuManifestDigest(validateHonkokuManifest(reordered, base)));
  const changed = structuredClone(manifest);
  changed.files.vocab.sha256 = 'b'.repeat(64);
  assert.notEqual(await honkokuManifestDigest(manifest), await honkokuManifestDigest(changed));
});

test('manifest rejects every incompatible identity, shape, and file boundary', () => {
  const invalid: Array<(value: ReturnType<typeof fixture>) => void> = [
    (v) => { v.schemaVersion = 1; }, (v) => { v.engineId = 'honkoku-v18'; },
    (v) => { v.upstreamRepository = 'another/repository'; }, (v) => { v.upstreamCommit = 'b'.repeat(40); },
    (v) => { v.runtime = { ...v.runtime, inputWidth: 256 } as typeof v.runtime; },
    (v) => { v.runtime = { ...v.runtime, vocabularySize: 7709 } as typeof v.runtime; },
    (v) => { v.files.vocab.url = 'http://example.test/vocab'; },
    (v) => { v.files.vocab.url = 'https://user:pass@example.test/vocab'; },
    (v) => { v.files.vocab.sha256 = 'invalid'; }, (v) => { v.files.vocab.bytes = 0; },
    (v) => { v.files.vocab.bytes = NaN; }, (v) => { delete v.files.vocab; },
    (v) => { v.files.vocab.url = v.files.encoderInt8.url; },
  ];
  for (const mutate of invalid) { const value = fixture(); mutate(value); assert.throws(() => validateHonkokuManifest(value, base)); }
  assert.throws(() => validateHonkokuManifest({ ...fixture(), extra: true }, base));
  assert.throws(() => validateHonkokuManifest(fixture(), 'http://example.test/manifest.json'));
});

test('manifest HTTP and oversized responses fail before execution', async () => {
  const fetcher = (response: Response) => (async () => response) as typeof fetch;
  await assert.rejects(fetchHonkokuManifest(base, undefined, fetcher(new Response('', { status: 404 }))));
  await assert.rejects(fetchHonkokuManifest(base, undefined, fetcher(new Response(' '.repeat(65537)))));
  const result = await fetchHonkokuManifest(base, undefined, fetcher(new Response(JSON.stringify(fixture()))));
  assert.equal(result.digest.length, 64);
});

test('NDL resolves a full SHA and pins actual asset URLs, never master', async () => {
  assert.throws(() => requireModelRevision('master'));
  assert.throws(() => ndlModelAssetUrls('../master'));
  const fetcher = (async () => new Response(JSON.stringify({ sha: revision }))) as typeof fetch;
  assert.equal(await resolveLatestNdlModelRevision(undefined, fetcher), revision);
  const urls = ndlModelAssetUrls(revision);
  assert.ok(Object.values(urls).every((url) => url.includes(`/${revision}/`) && !url.includes('/master/')));
  await assert.rejects(resolveLatestNdlModelRevision(undefined, (async () => new Response('{}')) as typeof fetch));
  const pinned = await pinPageOcrRequest({ engineId: 'ndl-parseq', options: normalizeNdlOcrOptions({ modelRevision: revision }) });
  validatePinnedPageOcrRequest(pinned);
  assert.equal(pinned.expectedIdentity.detectorRevision, revision);
  assert.throws(() => validatePinnedPageOcrRequest({ ...pinned, options: { ...pinned.options, modelRevision: 'b'.repeat(40) } }));
  const honkoku = await pinPageOcrRequest({ engineId: 'honkoku-v19', options: pinned.options });
  assert.equal(honkoku.modelManifestUrl, undefined);
  validatePinnedPageOcrRequest(honkoku);
  assert.equal((await verifyPinnedHonkokuManifest(honkoku)).engineId, 'honkoku-v19');
  await assert.rejects(verifyPinnedHonkokuManifest({ ...honkoku,
    expectedIdentity: { ...honkoku.expectedIdentity, modelManifestDigest: 'f'.repeat(64) } }), /manifest changed/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(pinPageOcrRequest({ engineId: 'ndl-parseq', options: pinned.options }, controller.signal), { name: 'AbortError' });
});

test('cache identity separates engine, detector, recognizer, digest and stable options', () => {
  const input = { identity: ndlExecutionIdentity(revision), manifestUrl: base, canvasId: '1', imageServiceId: 'image',
    profile: 'balanced' as const, options: normalizeNdlOcrOptions({ modelRevision: revision }) };
  const first = pageOcrCacheKey(input);
  assert.equal(first, pageOcrCacheKey({ ...input, options: Object.fromEntries(Object.entries(input.options).reverse()) as typeof input.options }));
  for (const identity of [
    { ...input.identity, detectorRevision: 'b'.repeat(40) },
    { ...input.identity, recognizerRevision: 'b'.repeat(40) },
    { ...input.identity, engineId: 'honkoku-v19' as const, modelManifestDigest: 'c'.repeat(64) },
    { ...input.identity, pipelineVersion: 'new' },
  ]) assert.notEqual(first, pageOcrCacheKey({ ...input, identity }));
  const honkoku = { ...input, identity: { ...input.identity, engineId: 'honkoku-v19' as const, modelManifestDigest: 'c'.repeat(64) } };
  assert.notEqual(pageOcrCacheKey(honkoku), pageOcrCacheKey({ ...honkoku, identity: { ...honkoku.identity, modelManifestDigest: 'd'.repeat(64) } }));
});

test('confidence preserves PARSeq thresholds without treating Honkoku diagnostics as accuracy', () => {
  const line = { text: '仮名', detectionScore: 0.9, recognitionScore: 0.6, endedWithEos: true };
  assert.equal(confidencePresentation(line, 'balanced').reviewNeeded, false);
  assert.equal(confidencePresentation(line, 'accurate').reviewNeeded, true);
  const generated = { text: '仮名', detectionScore: 0.9, confidenceKind: 'autoregressive-token' as const, stopReason: 'eos' as const };
  assert.equal(confidencePresentation(generated, 'accurate').reviewNeeded, false);
  assert.equal(confidencePresentation({ ...generated, meanLogProbability: -100 }, 'accurate').percent, undefined);
  for (const stopReason of ['max-length', 'degenerate-repeat', 'invalid-token', 'incomplete'] as const) {
    assert.equal(confidencePresentation({ ...generated, stopReason }, 'fast').reviewNeeded, true);
  }
  assert.equal(confidencePresentation({ ...generated, text: '' }, 'fast').reviewNeeded, true);
  assert.equal(recognitionAveragePercent([line]), 60);
  assert.equal(recognitionAveragePercent([line, generated]), undefined);
  assert.equal(recognitionAveragePercent([{ text: 'missing score', detectionScore: 1 }]), undefined);
});

test('viewer preserves target protection, transforms geometry and records engine provenance', () => {
  const target = page();
  const manifest = { url: base, pages: [target], status: 'iiifLoaded' } as ViewerManifest;
  const identity = { ...ndlExecutionIdentity(revision), engineId: 'honkoku-v19' as const, engineLabel: 'みんなで翻刻OCR v19',
    recognizerRevision: HONKOKU_V19_UPSTREAM_COMMIT, modelManifestDigest: 'b'.repeat(64) };
  const result = { identity, revision: identity.recognizerRevision, pipelineVersion: identity.pipelineVersion,
    imageWidth: 100, imageHeight: 200, provider: 'WASM', profile: 'balanced', options: normalizeNdlOcrOptions(),
    stats: {}, lines: [{ text: '本文ニ', rawKoji: '本文<OKURI>ニ</OKURI>', detectionScore: 0.9,
      region: { x: 1, y: 2, width: 3, height: 4 }, confidenceKind: 'autoregressive-token', stopReason: 'eos' }],
  } as PageOcrResult;
  assert.equal(applyOcrResult({ manifest, targetManifestUrl: 'other', targetCanvasId: 'canvas', result }).applied, false);
  assert.equal(applyOcrResult({ manifest, targetManifestUrl: base, targetCanvasId: 'other', result }).applied, false);
  assert.equal(target.result.length, 0);
  assert.equal(applyOcrResult({ manifest, targetManifestUrl: base, targetCanvasId: 'canvas', result }).applied, true);
  assert.deepEqual(target.result[0].region, { x: 2, y: 4, width: 6, height: 8 });
  assert.equal(target.ocrIdentity?.engineId, 'honkoku-v19');
  assert.equal(target.result[0].rawKoji, '本文<OKURI>ニ</OKURI>');
  const record = createOcrBenchmarkRecord({ page: target, manifestUrl: base });
  assert.deepEqual(record.identity, identity);
  const changed = { ...record, identity: { ...identity, modelManifestDigest: 'c'.repeat(64) } };
  assert.notEqual(ocrBenchmarkDeterministicFingerprint(record), ocrBenchmarkDeterministicFingerprint(changed));
  assert.notEqual(ocrLinesFingerprint(result.lines), ocrLinesFingerprint([{ ...result.lines[0], rawKoji: 'changed' }]));
  assert.match(serializeBenchmarkCsv(record), /ocrEngineId/);
  assert.match(serializeBenchmarkCsv(record), /honkoku-v19/);
});

test('manifest builder computes actual hashes/bytes and rejects missing assets and bad vocab', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'honkoku-test-'));
  try {
    for (const [role, name] of Object.entries(HONKOKU_FILE_NAMES)) await writeFile(join(directory, name),
      role === 'vocab' ? JSON.stringify(Array.from({ length: 7710 }, (_, i) => String(i))) : 'fixture-model-not-onnx');
    const manifest = await buildHonkokuManifest(directory, base);
    assert.equal(manifest.files.encoderInt8.bytes, 22);
    assert.match(manifest.files.encoderInt8.sha256, /^[a-f0-9]{64}$/);
    await writeFile(join(directory, HONKOKU_FILE_NAMES.vocab), '[]');
    await assert.rejects(buildHonkokuManifest(directory, base), /7710/);
    await rm(join(directory, HONKOKU_FILE_NAMES.encoderInt8));
    await assert.rejects(buildHonkokuManifest(directory, base));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('persisted Honkoku manifest digest mismatch refuses resume', async () => {
  const manifest = validateHonkokuManifest(fixture(), base);
  const identity = { ...ndlExecutionIdentity(revision), engineId: 'honkoku-v19' as const,
    engineLabel: 'みんなで翻刻OCR v19', recognizerRevision: HONKOKU_V19_UPSTREAM_COMMIT,
    upstreamCommit: HONKOKU_V19_UPSTREAM_COMMIT, upstreamRepository: HONKOKU_UPSTREAM_REPOSITORY,
    modelManifestDigest: await honkokuManifestDigest(manifest) };
  const request: PinnedPageOcrRequest = { schemaVersion: 1, engineId: 'honkoku-v19',
    options: normalizeNdlOcrOptions({ modelRevision: revision }), modelManifestUrl: base + 'manifest.json', expectedIdentity: identity };
  assert.throws(() => validatePinnedPageOcrRequest({ ...request, expectedIdentity: { ...identity, engineLabel: 'Wrong model' } }));
  const original = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify(fixture())); }) as typeof fetch;
    const verified = await verifyPinnedHonkokuManifest(request);
    assert.equal(verified.upstreamCommit, HONKOKU_V19_UPSTREAM_COMMIT);
    assert.equal(calls, 1);
    await assert.rejects(verifyPinnedHonkokuManifest({ ...request, expectedIdentity: { ...identity, modelManifestDigest: 'f'.repeat(64) } }), /changed/);
  } finally { globalThis.fetch = original; }
});

test('Honkoku is available by default and can still be explicitly disabled', () => {
  assert.equal(honkokuEnabled(), true);
  assert.equal(honkokuEnabled('false'), false);
  assert.equal(honkokuEnabled('true'), true);
});

test('generation scores expose measured self-confidence without inventing accuracy', () => {
  const line = { text: '本文', detectionScore: 0.99, recognizerId: 'honkoku-v19' as const,
    generatedTokens: 4, meanLogProbability: Math.log(0.8), stopReason: 'eos' as const };
  assert.ok(Math.abs(generationScore(line)! - 80) < 1e-10);
  assert.equal(generationScore({ ...line, meanLogProbability: 0 }), 100);
  assert.equal(generationScore({ ...line, meanLogProbability: -1000 }), 0);
  for (const meanLogProbability of [undefined, NaN, Infinity, -Infinity, 0.1]) {
    assert.equal(generationScore({ ...line, meanLogProbability }), undefined);
  }
  for (const generatedTokens of [undefined, 0, -1, 1.5, NaN]) {
    assert.equal(generationScore({ ...line, generatedTokens }), undefined);
  }
  assert.equal(generationScore({ ...line, recognizerId: 'ndl-parseq' }), undefined);
  assert.equal(recognitionAveragePercent([line]), undefined);
  assert.equal(confidencePresentation(line, 'balanced').percent, undefined);
  assert.equal(confidencePresentation({ ...line, meanLogProbability: -100 }, 'accurate').reviewNeeded, false);
  assert.equal(confidencePresentation({ ...line, stopReason: 'max-length' }, 'balanced').reviewNeeded, true);
});

test('page generation score pools token logs and refuses missing or mixed diagnostics', () => {
  const first = { text: '甲', detectionScore: 0.9, confidenceKind: 'autoregressive-token' as const,
    generatedTokens: 1, meanLogProbability: Math.log(0.25) };
  const second = { ...first, text: '乙丙丁', generatedTokens: 3, meanLogProbability: Math.log(0.81) };
  const copy = structuredClone([first, second]);
  const expected = 100 * Math.exp((Math.log(0.25) + 3 * Math.log(0.81)) / 4);
  assert.ok(Math.abs(generationAverageScore([first, second])! - expected) < 1e-10);
  assert.deepEqual([first, second], copy);
  assert.equal(generationAverageScore([]), undefined);
  assert.equal(generationAverageScore([first, { ...second, meanLogProbability: undefined }]), undefined);
  assert.equal(generationAverageScore([first, { text: 'NDL', detectionScore: 0.9, recognitionScore: 0.99 }]), undefined);
});
