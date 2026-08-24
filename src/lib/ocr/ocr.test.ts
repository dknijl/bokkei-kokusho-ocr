import assert from "node:assert/strict";
import test from "node:test";
import { compareRecognitionSelectionStrategies, selectRecognitionCandidate } from "./candidates.ts";
import {
  compareOcrBenchmarkRunDeterminism,
  createOcrBenchmarkRecord,
  ocrBenchmarkDeterministicFingerprint,
  ocrLinesFingerprint,
  parseOcrGroundTruthJson,
  serializeBenchmarkCsv,
} from "./benchmark.ts";
import { compareOcrBenchmarkBaselines, runOcrBenchmarkDataset, viewerPageFromGroundTruth } from "./benchmark-runner.ts";
import { levenshteinDistance } from "./edit-distance.ts";
import { buildLineCropUrl, expandCropRegion, floorCeilCropRegion } from "./image.ts";
import { evaluateOcrPage } from "./metrics.ts";
import { globalNms, mergeAdjacentDetections } from "./nms.ts";
import { isOcrModelCacheFresh, OCR_MODEL_CACHE_MAX_AGE_MS } from "./model-cache.ts";
import {
  combineSegmentRecognitions,
  createLineWindows,
  findSignificantInkGap,
  mergeSegmentTexts,
} from "./line-segmentation.ts";
import { xyCutOrder } from "./reading-order.ts";
import { createAdaptiveTiles, restoreTileRegion } from "./tiling.ts";
import { decodeRecognition, stableLogSoftmax } from "./recognition-score.ts";
import { MAX_EXTRA_RECOGNITIONS, normalizeNdlOcrOptions } from "./profiles.ts";
import { withProviderFallback } from "./provider-fallback.ts";

test("levenshtein distance handles Unicode characters", () => {
  assert.equal(levenshteinDistance("かな", "かさな"), 1);
  assert.equal(levenshteinDistance("", "漢"), 1);
});

test("global NMS suppresses contained and non-adjacent duplicates", () => {
  const result = globalNms([
    { x: 0, y: 0, width: 20, height: 20, detectionScore: 0.4 },
    { x: 100, y: 0, width: 20, height: 20, detectionScore: 0.7 },
    { x: 4, y: 4, width: 8, height: 8, detectionScore: 0.2 },
    { x: 200, y: 0, width: 20, height: 20, detectionScore: 0.5 },
  ]);
  assert.deepEqual(result.map((item) => item.detectionScore), [0.7, 0.5, 0.4]);
});

test("adjacent vertical fragments merge without joining neighboring columns", () => {
  const result = mergeAdjacentDetections([
    { x: 100, y: 0, width: 12, height: 40, detectionScore: 0.7 },
    { x: 100, y: 43, width: 12, height: 36, detectionScore: 0.6 },
    { x: 80, y: 0, width: 12, height: 79, detectionScore: 0.8 },
  ], { orientation: "vertical", maxGapRatio: 1.2, transverseOverlapThreshold: 0.65 });
  assert.equal(result.length, 2);
  const merged = result.find((item) => item.x === 100);
  assert.deepEqual(merged, { x: 100, y: 0, width: 12, height: 79, detectionScore: 0.7 });
});

test("crop bounds expand outward and stay within the image", () => {
  assert.deepEqual(
    floorCeilCropRegion({ x: 1.2, y: 2.8, width: 3.1, height: 4.1 }, { width: 10, height: 10 }),
    { x: 1, y: 2, width: 4, height: 5 },
  );
  const padded = expandCropRegion(
    { x: 40, y: 20, width: 10, height: 100 },
    { longitudinalRatio: 0.1, transverseRatio: 0.5 },
    { width: 100, height: 150 },
    [{ x: 52, y: 20, width: 10, height: 100 }],
  );
  assert.ok(padded.x >= 0);
  assert.ok(padded.x + padded.width <= 100);
  assert.ok(padded.x + padded.width <= 52);
});

test("IIIF line crop URLs convert coordinates and fall back without a service", () => {
  const page = {
    canvasId: "canvas-1",
    imageServiceId: "https://example.test/iiif/service",
    label: "1",
    labelTranslations: { none: "1" },
    image: "https://example.test/image.jpg",
    thumbnail: "https://example.test/thumb.jpg",
    width: 1000,
    height: 2000,
    result: [],
  };
  assert.equal(
    buildLineCropUrl(
      page,
      { width: 100, height: 200 },
      { x: 10, y: 20, width: 10, height: 40 },
      { longitudinalRatio: 0, transverseRatio: 0 },
      512,
    ),
    "https://example.test/iiif/service/100,200,100,400/!512,512/0/default.jpg",
  );
  assert.equal(
    buildLineCropUrl(
      { ...page, imageServiceId: "" },
      { width: 100, height: 200 },
      { x: 10, y: 20, width: 10, height: 40 },
    ),
    "",
  );
});

test("recognition decoding uses stable probabilities and detects EOS", () => {
  const logProbabilities = stableLogSoftmax([1000, 999, 998]).map(Math.exp);
  assert.ok(Math.abs(logProbabilities.reduce((sum, value) => sum + value, 0) - 1) < 1e-9);

  const decoded = decodeRecognition(
    new Float32Array([
      -4, 5, 0,
      6, 0, -2,
      0, 0, 0,
    ]),
    3,
    3,
    ["甲", "乙"],
  );
  assert.equal(decoded.text, "甲");
  assert.equal(decoded.endedWithEos, true);
  assert.equal(decoded.tokenScores.length, 1);
  assert.ok(decoded.recognitionScore > 0);
});

test("candidate selection prefers independent agreement", () => {
  const result = selectRecognitionCandidate([
    {
      text: "甲",
      recognitionScore: 0.8,
      minimumTokenScore: 0.7,
      meanTokenMargin: 2,
      endedWithEos: true,
      source: "page",
      preprocessing: "original",
      order: 0,
    },
    {
      text: "乙",
      recognitionScore: 0.99,
      minimumTokenScore: 0.9,
      meanTokenMargin: 3,
      endedWithEos: true,
      source: "page",
      preprocessing: "padded",
      order: 1,
    },
    {
      text: "甲",
      recognitionScore: 0.7,
      minimumTokenScore: 0.6,
      meanTokenMargin: 1.5,
      endedWithEos: true,
      source: "iiif-crop",
      preprocessing: "high-resolution-original",
      order: 2,
    },
  ]);
  assert.equal(result.selected.text, "甲");
  assert.equal(result.reason, "consensus");
  assert.equal(result.uncertain, false);
});

test("candidate benchmark diagnostic compares consensus with score-only selection", () => {
  const comparison = compareRecognitionSelectionStrategies([
    {
      text: "甲",
      recognitionScore: 0.8,
      minimumTokenScore: 0.7,
      meanTokenMargin: 2,
      endedWithEos: true,
      source: "page",
      preprocessing: "original",
      order: 0,
    },
    {
      text: "乙",
      recognitionScore: 0.99,
      minimumTokenScore: 0.9,
      meanTokenMargin: 3,
      endedWithEos: true,
      source: "page",
      preprocessing: "padded",
      order: 1,
    },
    {
      text: "甲",
      recognitionScore: 0.7,
      minimumTokenScore: 0.6,
      meanTokenMargin: 1.5,
      endedWithEos: true,
      source: "iiif-crop",
      preprocessing: "high-resolution-original",
      order: 2,
    },
  ]);
  assert.equal(comparison.consensus.selected.text, "甲");
  assert.equal(comparison.scoreOnly.text, "乙");
  assert.equal(comparison.differs, true);
});

test("benchmark metrics report text and detection quality separately", () => {
  const metrics = evaluateOcrPage({
    predicted: [
      { text: "甲", detectionScore: 0.9, recognitionScore: 0.8, endedWithEos: true, region: { x: 0, y: 0, width: 10, height: 10 } },
      { text: "誤", detectionScore: 0.7, recognitionScore: 0.3, endedWithEos: true, region: { x: 20, y: 0, width: 10, height: 10 } },
    ],
    reference: {
      id: "test",
      manifestUrl: "https://example.test/manifest",
      canvasId: "canvas-1",
      imageServiceId: "https://example.test/iiif",
      width: 100,
      height: 100,
      tags: ["printed"],
      lines: [
        { text: "甲", region: { x: 0, y: 0, width: 10, height: 10 } },
        { text: "正", region: { x: 20, y: 0, width: 10, height: 10 } },
      ],
    },
  });
  assert.equal(metrics.detection.recall, 1);
  assert.equal(metrics.detection.precision, 1);
  assert.equal(metrics.raw.cer, 0.5);
  assert.equal(metrics.raw.exactLineRate, 0.5);
  assert.equal(metrics.lowConfidenceErrorDetectionRate, 1);
});

test("benchmark CER counts unmatched predicted text as insertions", () => {
  const metrics = evaluateOcrPage({
    predicted: [
      { text: "甲", detectionScore: 0.9, recognitionScore: 0.9, endedWithEos: true, region: { x: 0, y: 0, width: 10, height: 10 } },
      { text: "余", detectionScore: 0.8, recognitionScore: 0.9, endedWithEos: true, region: { x: 50, y: 0, width: 10, height: 10 } },
    ],
    reference: [{ text: "甲", region: { x: 0, y: 0, width: 10, height: 10 } }],
  });
  assert.equal(metrics.raw.cer, 1);
  assert.equal(metrics.detection.precision, 0.5);
});

test("reading order keeps vertical columns separate", () => {
  const order = xyCutOrder([
    { x: 100, y: 0, width: 12, height: 40 },
    { x: 100, y: 50, width: 12, height: 40 },
    { x: 20, y: 0, width: 12, height: 40 },
    { x: 20, y: 50, width: 12, height: 40 },
  ]);
  assert.deepEqual(order, [0, 1, 2, 3]);
});

test("reading order places a short upper block before the main vertical body", () => {
  const order = xyCutOrder([
    { x: 100, y: 0, width: 12, height: 20 },
    { x: 20, y: 0, width: 12, height: 20 },
    { x: 100, y: 35, width: 12, height: 80 },
    { x: 20, y: 35, width: 12, height: 80 },
  ]);
  assert.deepEqual(order, [0, 1, 2, 3]);
});

test("reading order keeps closely spaced vertical columns separate", () => {
  const order = xyCutOrder([
    { x: 100, y: 0, width: 14, height: 80 },
    { x: 86, y: 0, width: 14, height: 80 },
    { x: 72, y: 0, width: 10, height: 80 },
  ]);
  assert.deepEqual(order, [0, 1, 2]);
});

test("reading order separates adjacent columns whose boxes overlap", () => {
  const order = xyCutOrder([
    { x: 90, y: 0, width: 80, height: 100 },
    { x: 30, y: 0, width: 80, height: 100 },
  ]);
  assert.deepEqual(order, [0, 1]);
});

test("OCR model cache expires after seven days", () => {
  const savedAt = 1000;
  assert.equal(isOcrModelCacheFresh(savedAt, savedAt), true);
  assert.equal(isOcrModelCacheFresh(savedAt, savedAt + OCR_MODEL_CACHE_MAX_AGE_MS), true);
  assert.equal(isOcrModelCacheFresh(savedAt, savedAt + OCR_MODEL_CACHE_MAX_AGE_MS + 1), false);
  assert.equal(isOcrModelCacheFresh(savedAt, savedAt - 1), false);
});

test("OCR retry work is capped for resource safety", () => {
  assert.equal(normalizeNdlOcrOptions({ maxExtraRecognitions: 999 }).maxExtraRecognitions, MAX_EXTRA_RECOGNITIONS);
  assert.equal(normalizeNdlOcrOptions({ maxExtraRecognitions: -1 }).maxExtraRecognitions, 0);
  const accurate = normalizeNdlOcrOptions({ profile: "accurate" });
  const balanced = normalizeNdlOcrOptions({ profile: "balanced" });
  assert.equal(balanced.enableAdaptiveTiling, false);
  assert.equal(accurate.enableAdaptiveTiling, true);
  assert.equal(accurate.enableDeskewRetry, true);
  assert.equal(accurate.enableLongLineSegmentation, true);
  assert.equal(accurate.maxExtraRecognitions, 6);
});

test("ground truth JSON parser validates line regions", () => {
  const page = parseOcrGroundTruthJson(JSON.stringify({
    id: "page-1",
    manifestUrl: "https://example.test/manifest",
    canvasId: "canvas-1",
    imageServiceId: "https://example.test/iiif",
    width: 100,
    height: 100,
    tags: ["printed"],
    lines: [{ text: "甲", region: { x: 1, y: 2, width: 3, height: 4 } }],
  }));
  assert.equal(page.lines[0]?.text, "甲");
  assert.throws(() => parseOcrGroundTruthJson("{\"lines\":[{\"text\":\"甲\"}]}"));
});

test("ground truth keeps raw and normalized text separate", () => {
  const page = parseOcrGroundTruthJson(JSON.stringify({
    id: "page-1",
    manifestUrl: "https://example.test/manifest",
    canvasId: "canvas-1",
    lines: [{ text: "異体字", normalizedText: "異体字", region: { x: 0, y: 0, width: 1, height: 1 } }],
  }));
  assert.equal(page.lines[0]?.text, "異体字");
  assert.equal(page.lines[0]?.normalizedText, "異体字");
});

test("OCR line fingerprints ignore no result fields and remain deterministic", () => {
  const lines = [{
    id: "line-1",
    text: "甲",
    detectionScore: 0.8,
    recognitionScore: 0.7,
    endedWithEos: true,
  }];
  assert.equal(ocrLinesFingerprint(lines), ocrLinesFingerprint(lines.map((line) => ({ ...line }))));
  assert.notEqual(ocrLinesFingerprint(lines), ocrLinesFingerprint([{ ...lines[0], text: "乙" }]));
});

test("benchmark runner processes pages sequentially and compares baselines", async () => {
  const makePage = (id: string, text: string) => ({
    id,
    manifestUrl: "https://example.test/manifest",
    canvasId: `canvas-${id}`,
    imageServiceId: "https://example.test/iiif",
    width: 100,
    height: 100,
    tags: ["printed" as const],
    lines: [{ text, region: { x: 10, y: 10, width: 20, height: 20 } }],
  });
  const pages = [makePage("one", "甲"), makePage("two", "乙")];
  assert.equal(viewerPageFromGroundTruth(pages[0]!).canvasId, "canvas-one");
  const progress: number[] = [];
  const run = await runOcrBenchmarkDataset({
    pages,
    ocrOptions: normalizeNdlOcrOptions({ profile: "fast" }),
    onProgress: ({ pageIndex }) => progress.push(pageIndex),
    recognize: async (page, options, onProgress) => {
      onProgress({ stage: "done", percent: 100, messageKey: "progressDone", params: { count: 1 }, completed: 1, total: 1 });
      const text = page.canvasId.endsWith("one") ? "甲" : "乙";
      return {
        imageWidth: 100,
        imageHeight: 100,
        lines: [{ text, detectionScore: 0.9, recognitionScore: 0.9, endedWithEos: true, region: { x: 10, y: 10, width: 20, height: 20 } }],
        provider: "WASM" as const,
        revision: "model",
        pipelineVersion: "pipeline",
        profile: options.profile,
        options,
        stats: {
          detectionCount: 1,
          modelInferenceCount: 1,
          adaptiveTiles: 0,
          initialRecognitions: 1,
          extraRecognitions: 0,
          extraRecognitionAttempts: 0,
          highResolutionRetries: 0,
          additionalCropRequests: 0,
          additionalCropFailures: 0,
          maxCanvasPixels: 10000,
          durationMs: 1,
        },
      };
    },
  });
  assert.deepEqual(progress, [0, 1]);
  assert.equal(run.records.length, 2);
  assert.equal(run.records[0]?.metrics?.raw.cer, 0);
  assert.equal(compareOcrBenchmarkBaselines(run.baseline, run.baseline).length, 2);
});

test("benchmark determinism ignores volatile timestamps and runtime fields", async () => {
  const groundTruth = {
    id: "one",
    manifestUrl: "https://example.test/manifest",
    canvasId: "canvas-one",
    imageServiceId: "https://example.test/iiif",
    width: 100,
    height: 100,
    tags: ["printed" as const],
    lines: [{ text: "甲", region: { x: 10, y: 10, width: 20, height: 20 } }],
  };
  const options = normalizeNdlOcrOptions({ profile: "fast" });
  const page = viewerPageFromGroundTruth(groundTruth);
  const result = {
    imageWidth: 100,
    imageHeight: 100,
    lines: [{ text: "甲", detectionScore: 0.9, recognitionScore: 0.9, endedWithEos: true, region: { x: 10, y: 10, width: 20, height: 20 } }],
    provider: "WASM" as const,
    revision: "model",
    pipelineVersion: "pipeline",
    profile: options.profile,
    options,
    stats: {
      detectionCount: 1,
      modelInferenceCount: 1,
      adaptiveTiles: 0,
      initialRecognitions: 1,
      extraRecognitions: 0,
      extraRecognitionAttempts: 0,
      highResolutionRetries: 0,
      additionalCropRequests: 0,
      additionalCropFailures: 0,
      maxCanvasPixels: 10000,
      durationMs: 1,
    },
  };
  const record = createOcrBenchmarkRecord({
    page: { ...page, result: result.lines },
    manifestUrl: groundTruth.manifestUrl,
    modelRevision: result.revision,
    provider: result.provider,
    ocrOptions: options,
    stats: result.stats,
    groundTruth,
  });
  const recordStats = record.execution.stats;
  assert.ok(recordStats);
  const later = {
    ...record,
    createdAt: "2099-01-01T00:00:00.000Z",
    execution: {
      ...record.execution,
      browser: "different-browser",
      stats: { ...recordStats, durationMs: 9999 },
    },
  };
  assert.equal(ocrBenchmarkDeterministicFingerprint(record), ocrBenchmarkDeterministicFingerprint(later));
  assert.deepEqual(compareOcrBenchmarkRunDeterminism([record], [later]), {
    deterministic: true,
    differingCanvasIds: [],
  });
  const changed = {
    ...later,
    output: { ...later.output, fingerprint: later.output.fingerprint.replace("甲", "乙") },
  };
  assert.deepEqual(compareOcrBenchmarkRunDeterminism([record], [changed]), {
    deterministic: false,
    differingCanvasIds: ["canvas-one"],
  });
  const csv = serializeBenchmarkCsv(record);
  assert.match(csv, /modelInferenceCount,maxCanvasPixels/);
  assert.match(csv, /,1,10000,fast,/);
});

test("benchmark runner aborts before starting work", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runOcrBenchmarkDataset({
      pages: [{
        id: "aborted",
        manifestUrl: "https://example.test/manifest",
        canvasId: "canvas-aborted",
        imageServiceId: "https://example.test/iiif",
        width: 100,
        height: 100,
        tags: ["printed"],
        lines: [{ text: "甲", region: { x: 1, y: 1, width: 10, height: 10 } }],
      }],
      ocrOptions: normalizeNdlOcrOptions({ profile: "fast" }),
      signal: controller.signal,
      recognize: async () => {
        throw new Error("recognition should not start after abort");
      },
    }),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});

test("provider fallback uses WASM after WebGPU failure but not after abort", async () => {
  const events: string[] = [];
  const result = await withProviderFallback({
    primary: async () => {
      events.push("webgpu");
      throw new Error("webgpu unavailable");
    },
    fallback: async () => {
      events.push("wasm");
      return "WASM";
    },
    onFallback: () => events.push("fallback"),
  });
  assert.equal(result, "WASM");
  assert.deepEqual(events, ["webgpu", "fallback", "wasm"]);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    withProviderFallback({
      primary: async () => { throw new Error("cancelled"); },
      fallback: async () => "should-not-run",
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof Error && error.message === "cancelled",
  );
});

test("adaptive tiles are capped and restore local coordinates", () => {
  const tiles = createAdaptiveTiles(
    { width: 100, height: 300 },
    "balanced",
    [{ x: 10, y: 220, width: 20, height: 20 }],
  );
  assert.ok(tiles.length > 0);
  assert.ok(tiles.length <= 2);
  const restored = restoreTileRegion(tiles[0]!, { x: 1, y: 2, width: 3, height: 4 }, { width: 100, height: 300 });
  assert.ok(restored.x >= 0 && restored.y >= 0);
  assert.ok(restored.x + restored.width <= 100);
});

test("long-line windows preserve overlap when merging text", () => {
  const windows = createLineWindows({ x: 0, y: 0, width: 400, height: 20 }, { width: 400, height: 40 }, { maxWindows: 3 });
  assert.equal(windows.length, 3);
  assert.equal(mergeSegmentTexts(["甲乙", "乙丙", "丙丁"]), "甲乙丙丁");
  const merged = combineSegmentRecognitions([
    { text: "甲乙", recognitionScore: 0.8, minimumTokenScore: 0.7, meanTokenMargin: 1, endedWithEos: true },
    { text: "乙丙", recognitionScore: 0.6, minimumTokenScore: 0.5, meanTokenMargin: 0.8, endedWithEos: true },
  ]);
  assert.equal(merged?.text, "甲乙丙");
  assert.equal(merged?.endedWithEos, true);
});

test("ink-gap splitting finds a short marginal block separated from a long line", () => {
  const gap = findSignificantInkGap([
    ...Array.from({ length: 32 }, () => 0.2),
    ...Array.from({ length: 12 }, () => 0),
    ...Array.from({ length: 70 }, () => 0.2),
  ], 12);
  assert.deepEqual(gap, { start: 32, end: 44 });
  assert.equal(findSignificantInkGap([
    ...Array.from({ length: 45 }, () => 0.2),
    ...Array.from({ length: 12 }, () => 0),
    ...Array.from({ length: 45 }, () => 0.2),
  ], 12), null);
});
