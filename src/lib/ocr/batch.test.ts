import test from "node:test";
import assert from "node:assert/strict";
import { BlobReader, BlobWriter, TextWriter, ZipReader } from "@zip.js/zip.js";
import { BatchController, type OcrJob, type OcrJobPage, type JobStore } from "./batch.ts";
import { normalizeNdlOcrOptions, DEFAULT_NDL_OCR_OPTIONS } from "./profiles.ts";
import { OCR_PIPELINE_VERSION } from "./benchmark.ts";
import { NDL_MODEL_REVISION } from "./model-revision.ts";
import { OcrFailure, fetchOcrResource } from "./network.ts";
import { createScrollRegions, parseImageServiceInfo, imageSizeParameter, toSourceRegion, toSegmentRegion } from "./image-source.ts";
import { planZipParts, writeJobZip } from "./zip-export.ts";
import { scheduleRetries, APPROVED_IMAGE_CORRECTIONS, type RetryTarget } from "./retry-policy.ts";
import { sauvolaImage } from "./preprocessing.ts";
import { evaluateOcrPage } from "./metrics.ts";
import type { NdlOcrResult } from "../ndl-ocr.ts";
import { buildOcrCacheKeyForPage } from "./cache.ts";
import type { ViewerPage } from "../iiif.ts";

const options = normalizeNdlOcrOptions();
const page = (index: number): ViewerPage => ({ canvasId: `canvas/${index}`, canvasIndex: index, imageServiceId: "", image: `https://example.test/${index}.png`,
  label: `コマ${index + 1}`, labelTranslations: {}, thumbnail: "", width: 1000, height: 2000, result: [] });
const result = (text = "𠮷野の山\n"): NdlOcrResult => ({ imageWidth: 1000, imageHeight: 2000,
  lines: text ? [{ text, detectionScore: 0.9, readingOrder: 0 }] : [], provider: "WASM", revision: NDL_MODEL_REVISION,
  pipelineVersion: OCR_PIPELINE_VERSION, profile: "balanced", options,
  stats: { detectionCount: 1, modelInferenceCount: 2, initialRecognitions: 1, extraRecognitions: 0, extraRecognitionAttempts: 0,
    adaptiveTiles: 0, highResolutionRetries: 0, additionalCropRequests: 0, additionalCropFailures: 0, maxCanvasPixels: 2000000, durationMs: 1 } });
function fixture(total: number) {
  const job: OcrJob = { id: "job", manifestUrl: "https://example.test/manifest", title: "資料", recordId: "1", modelRevision: NDL_MODEL_REVISION,
    pipelineVersion: OCR_PIPELINE_VERSION, options, total, completed: 0, failed: 0, nextIndex: 0, status: "ready", createdAt: 0, updatedAt: 0 };
  const rows: OcrJobPage[] = Array.from({ length: total }, (_, index) => ({ jobId: job.id, index, page: page(index), status: "pending" }));
  let saved = structuredClone(job);
  const store: JobStore = {
    async getPage(_id, index) { return structuredClone(rows[index]); },
    async saveJob(value) { saved = structuredClone(value); },
    async commitPage(value, row) { saved = structuredClone(value); rows[row.index] = structuredClone(row); },
  };
  const dependencies = { store, onChange: (_job: OcrJob) => undefined,
    prepare: async (page: ViewerPage) => ({ page, key: page.canvasId }), readCache: async () => null };
  return { job, rows, store, dependencies, saved: () => saved };
}

test("scroll tiles cover both orientations, include the last edge, and preserve coordinate transforms", () => {
  for (const [width, height] of [[12000, 1000], [1000, 12000], [1000, 2000]]) {
    const tiles = createScrollRegions(width, height, options);
    assert.equal(tiles[0].x, 0); assert.equal(tiles[0].y, 0);
    const last = tiles.at(-1)!;
    assert.equal(last.x + last.width, width); assert.equal(last.y + last.height, height);
    const horizontal = width > height;
    for (let index = 1; index < tiles.length; index++) {
      const a = tiles[index - 1], b = tiles[index];
      assert.ok(horizontal ? b.x < a.x + a.width : b.y < a.y + a.height);
    }
    const local = { x: 50, y: 80, width: 20, height: 150 };
    const bitmap = { width: 600, height: 400 };
    const restored = toSegmentRegion(toSourceRegion(local, last, bitmap), last, bitmap);
    for (const key of ["x", "y", "width", "height"] as const) assert.ok(Math.abs(local[key] - restored[key]) < 1e-8);
  }
});

test("IIIF size requests respect source dimensions, level0 sizes and server pixel limits", () => {
  const info = parseImageServiceInfo({ width: 8000, height: 1000, type: "ImageService3", profile: "level2", maxWidth: 1500, maxArea: 500000 });
  const size = imageSizeParameter(info, { x: 0, y: 0, width: 1000, height: 1000 }, 2048);
  assert.equal(size, "!707,707");
  const level0 = parseImageServiceInfo({ width: 1000, height: 2000, profile: "http://iiif.io/api/image/2/level0.json", sizes: [{ width: 500, height: 1000 }] });
  assert.equal(level0.region, false);
  assert.equal(imageSizeParameter(level0, { x: 0, y: 0, width: 1000, height: 2000 }, 1200), "500,1000");
  assert.throws(() => imageSizeParameter({ ...level0, sizes: [] }, { x: 0, y: 0, width: 1000, height: 2000 }, 1200));
});

test("page-wide retries reach later low-resolution lines before repeating early lines", () => {
  const targets: RetryTarget[] = Array.from({ length: 3 }, (_, index) => ({ index, score: 0.2, lowConfidence: true,
    shortSide: index === 2 ? 8 : 40, aspectRatio: 8, quality: { contrast: 80, backgroundVariation: 0 } }));
  const retries = scheduleRetries(targets, options, true);
  assert.deepEqual(retries.map((item) => item.index), [2, 0]);
  assert.deepEqual(APPROVED_IMAGE_CORRECTIONS, []);
  assert.ok(!scheduleRetries(targets, normalizeNdlOcrOptions({ profile: "accurate" }), true).some((item) => ["sauvola", "background-normalized"].includes(item.kind)));
});

test("Sauvola keeps uniform paper white and dark strokes black without changing alpha", () => {
  const data = new Uint8ClampedArray(25 * 25 * 4).fill(255);
  for (let y = 5; y < 20; y++) {
    const i = (y * 25 + 12) * 4; data[i] = data[i + 1] = data[i + 2] = 30; data[i + 3] = 128;
  }
  const processed = sauvolaImage({ width: 25, height: 25, data });
  assert.equal(processed.data[0], 255);
  assert.equal(processed.data[(10 * 25 + 12) * 4], 0);
  assert.equal(processed.data[(10 * 25 + 12) * 4 + 3], 128);
  assert.equal(data[(10 * 25 + 12) * 4], 30);
});

test("raw CER uses original spelling and page CER detects reversed reading order", () => {
  const region = { x: 0, y: 0, width: 10, height: 100 };
  const reference = [{ text: "國", normalizedText: "国", region }, { text: "山", region: { ...region, x: 20 } }];
  const predicted = [{ text: "國", region, detectionScore: 1, readingOrder: 1 }, { text: "山", region: { ...region, x: 20 }, detectionScore: 1, readingOrder: 0 }];
  const metrics = evaluateOcrPage({ predicted, reference, normalizedText: (s) => s.replaceAll("國", "国") });
  assert.equal(metrics.raw.cer, 0);
  assert.equal(metrics.normalized?.cer, 0);
  assert.ok(metrics.pageCer > 0);
  assert.equal(metrics.readingOrderAccuracy, 0);
});

test("cache identity changes with the direct image URL and true pixel dimensions", () => {
  const key = (p: ViewerPage) => buildOcrCacheKeyForPage(p, "manifest", NDL_MODEL_REVISION, OCR_PIPELINE_VERSION, options);
  assert.notEqual(key(page(0)), key({ ...page(0), image: "https://example.test/new.png" }));
  assert.notEqual(key(page(0)), key({ ...page(0), sourceWidth: 9000 }));
});

test("1000 canvases run serially and only durable results advance the count", async () => {
  const f = fixture(1000);
  let active = 0, maxActive = 0, calls = 0;
  const completed = await new BatchController().run(f.job, { ...f.dependencies, recognize: async () => {
    active++; maxActive = Math.max(maxActive, active); calls++; await Promise.resolve(); active--; return result();
  } });
  assert.equal(completed.completed, 1000); assert.equal(calls, 1000); assert.equal(maxActive, 1);
  assert.equal(completed.status, "completed"); assert.equal(f.saved().completed, 1000);
});

test("pause commits the current canvas and resume skips it", async () => {
  const f = fixture(3), controller = new BatchController();
  let calls = 0;
  const paused = await controller.run(f.job, { ...f.dependencies, recognize: async () => { calls++; controller.pause(); return result(); } });
  assert.equal(paused.status, "paused"); assert.equal(paused.completed, 1);
  const completed = await new BatchController().run(paused, { ...f.dependencies, recognize: async () => { calls++; return result(); } });
  assert.equal(completed.completed, 3); assert.equal(calls, 3);
});

test("cancel discards the active page while preserving earlier checkpoints", async () => {
  const f = fixture(3), controller = new BatchController();
  const stopped = await controller.run(f.job, { ...f.dependencies, recognize: async (page) => {
    if (page.canvasIndex === 1) controller.cancel();
    return result();
  } });
  assert.equal(stopped.status, "cancelled"); assert.equal(stopped.completed, 1); assert.equal(f.rows[1].status, "pending");
});

test("image failures continue; unsupported and no-text-detected keep their canvas numbers", async () => {
  const f = fixture(4);
  f.rows[1].page.ocrAvailability = "unsupported";
  const done = await new BatchController().run(f.job, { ...f.dependencies, recognize: async (page) => {
    if (page.canvasIndex === 2) throw new OcrFailure("HTTP 404", "image");
    return result(page.canvasIndex === 3 ? "" : "文字");
  } });
  assert.equal(done.completed, 4); assert.equal(done.failed, 2); assert.equal(done.status, "completed-with-errors");
  assert.deepEqual(f.rows.map((row) => row.status), ["done", "unsupported", "failed", "no-text-detected"]);
  const retried = await new BatchController().run(done, { ...f.dependencies, retryFailures: true, recognize: async () => result() });
  assert.equal(retried.failed, 1); assert.equal(retried.completed, 4);
});

test("a storage failure cannot report the uncommitted page as complete", async () => {
  const f = fixture(2);
  f.store.commitPage = async () => { throw new OcrFailure("QuotaExceededError", "storage"); };
  await assert.rejects(new BatchController().run(f.job, { ...f.dependencies, recognize: async () => result() }), /Quota/);
  assert.equal(f.saved().completed, 0); assert.equal(f.rows[0].status, "pending");
});

test("model failure stops the job and version mismatch prevents mixing results", async () => {
  const f = fixture(2); let calls = 0;
  await assert.rejects(new BatchController().run(f.job, { ...f.dependencies, recognize: async () => { calls++; throw new OcrFailure("model failed", "model"); } }), /model failed/);
  assert.equal(calls, 1); assert.equal(f.saved().completed, 0);
  await assert.rejects(new BatchController().run({ ...f.job, pipelineVersion: "old" }, { ...f.dependencies, recognize: async () => result() }), /different OCR version/);
});

test("a resolved model revision remains fixed across pause and resume and rejects a different result", async () => {
  const f = fixture(2), controller = new BatchController();
  const revision = "a".repeat(40);
  f.job = { ...f.job, modelRevision: revision, options: normalizeNdlOcrOptions({ modelRevision: revision }) };
  const paused = await controller.run(f.job, { ...f.dependencies, recognize: async (_page, settings) => {
    assert.equal(settings.modelRevision, revision); controller.pause();
    return { ...result(), revision, options: settings };
  } });
  await assert.rejects(new BatchController().run(paused, { ...f.dependencies, recognize: async () => result() }), /does not match/);
  assert.equal(f.saved().completed, 1);
  assert.equal(f.rows[1].status, "pending");
  const done = await new BatchController().run(f.saved(), { ...f.dependencies, recognize: async (_page, settings) => {
    assert.equal(settings.modelRevision, revision);
    return { ...result(), revision, options: settings };
  } });
  assert.equal(done.status, "completed");
  assert.ok(f.rows.every(row => row.result?.revision === revision));
});

test("generated ZIP extracts UTF-8 text, empty pages, errors, and all canvas records", async () => {
  const f = fixture(4);
  f.rows[0] = { ...f.rows[0], status: "done", result: result("𠮷野の山") };
  f.rows[1] = { ...f.rows[1], status: "no-text-detected", result: result("") };
  f.rows[2] = { ...f.rows[2], status: "failed", error: "HTTP 404" };
  const blob = await writeJobZip(f.job, new BlobWriter("application/zip"), f.store);
  assert.ok(blob instanceof Blob);
  const reader = new ZipReader(new BlobReader(blob));
  const entries = await reader.getEntries();
  const texts = new Map<string, string>();
  for (const entry of entries) if (!entry.directory) texts.set(entry.filename, await entry.getData(new TextWriter()));
  await reader.close();
  assert.equal(texts.get("texts/00001.txt"), "𠮷野の山\n");
  assert.equal(texts.get("texts/00002.txt"), "");
  assert.match(texts.get("errors/00003.txt")!, /HTTP 404/);
  assert.ok(!texts.has("texts/00004.txt"));
  assert.match(texts.get("index.csv")!, /canvas\/3.*pending/);
  assert.deepEqual([...texts.keys()].sort(), ["errors/00003.txt", "index.csv", "texts/00001.txt", "texts/00002.txt"]);
  const exactFit = await planZipParts(f.job, f.store, { bytes: 1024, entries: 4 });
  assert.deepEqual(exactFit.map((part) => part.indices), [[0, 1, 2]]);
  const parts = await planZipParts(f.job, f.store, { bytes: 1024, entries: 3 });
  assert.deepEqual(parts.map((part) => part.indices), [[0, 1], [2]]);
  for (const part of parts) {
    const split = await writeJobZip(f.job, new BlobWriter("application/zip"), f.store, part);
    assert.ok(split instanceof Blob);
    const archive = new ZipReader(new BlobReader(split));
    const files = await archive.getEntries();
    assert.equal(files.length, part.indices.length + 1);
    assert.ok(files.length <= 3);
    assert.ok(files.some(entry => entry.filename === "index.csv"));
    assert.ok(!files.some(entry => entry.filename === "run.json"));
    await archive.close();
  }
});

test("network retry is bounded and abort is never converted to an image error", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response("missing", { status: 404 }); };
    await assert.rejects(fetchOcrResource("https://example.test/a"), /404/); assert.equal(calls, 1);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(fetchOcrResource("https://example.test/a", {}, controller.signal), { name: "AbortError" }); assert.equal(calls, 1);
    globalThis.fetch = async () => { calls++; return new Response("busy", { status: 503 }); };
    await assert.rejects(fetchOcrResource("https://example.test/a"), /503/); assert.equal(calls, 4);
  } finally { globalThis.fetch = originalFetch; }
});
