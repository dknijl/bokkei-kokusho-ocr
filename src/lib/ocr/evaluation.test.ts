import test from "node:test";
import assert from "node:assert/strict";
import { characterErrors } from "./edit-distance.ts";
import { assessCorrection, EVALUATION_GROUPS } from "./evaluation-gate.ts";
import { createOcrBenchmarkRecord } from "./benchmark.ts";
import { mergeSourceDetections } from "./source-detections.ts";
import { buildLineCropUrl } from "./image.ts";
import { selectRecognitionCandidate } from "./candidates.ts";

test("page character error accounting distinguishes insertion, deletion, substitution and supplementary characters", () => {
  assert.deepEqual(characterErrors("𠮷野", "𠮷野山"), { substitutions: 0, deletions: 0, insertions: 1, distance: 1 });
  assert.deepEqual(characterErrors("𠮷野山", "𠮷山"), { substitutions: 0, deletions: 1, insertions: 0, distance: 1 });
  assert.deepEqual(characterErrors("春山", "秋山"), { substitutions: 1, deletions: 0, insertions: 0, distance: 1 });
});

test("tile seam fragments preserve their full extent and do not reconnect same-tile separated writing", () => {
  const boxes = [
    { x: 100, y: 10, width: 20, height: 100, detectionScore: .8, sourceTile: 0 },
    { x: 100, y: 90, width: 20, height: 100, detectionScore: .9, sourceTile: 1 },
    { x: 100, y: 200, width: 20, height: 20, detectionScore: .8, sourceTile: 1 },
    { x: 135, y: 90, width: 20, height: 100, detectionScore: .8, sourceTile: 1 },
  ];
  const merged = mergeSourceDetections(boxes, "vertical");
  assert.equal(merged.length, 3);
  assert.ok(merged.some(box => box.y === 10 && box.height === 180));
  assert.ok(merged.some(box => box.y === 200 && box.height === 20));
});

const region = { x: 10, y: 10, width: 20, height: 200 };
const truth = { id: "p", manifestUrl: "https://example.test/manifest", canvasId: "canvas1", imageServiceId: "https://example.test/image", width: 1000, height: 1000,
  bookId: "book1", split: "evaluation" as const, trainingOverlap: "excluded" as const, annotationCoverage: "complete" as const,
  tags: ["manuscript", "printed", "illustrated", "scroll", "faded", "scattered"] as any, lines: [{ text: "春の山", region }] };
const makeRecord = (text: string) => createOcrBenchmarkRecord({ page: { canvasId: truth.canvasId, imageServiceId: truth.imageServiceId, width: 1000, height: 1000, image: "", thumbnail: "", label: "", labelTranslations: {}, result: [{ text, region, detectionScore: 1 }] }, manifestUrl: truth.manifestUrl, groundTruth: truth, modelRevision: "fixed-model", provider: "WASM" });

test("approval gate fails closed for partial truth, calibration leakage, training overlap and missing groups", () => {
  const before = makeRecord("秋の山"), after = makeRecord("春の山");
  assert.equal(assessCorrection([before], [after]).eligible, true);
  assert.equal(assessCorrection([before], [after], ["book1"]).eligible, false);
  for (const change of [{ annotationCoverage: "partial" }, { trainingOverlap: "known" }, { tags: ["printed"] }]) {
    const b = structuredClone(before), a = structuredClone(after);
    Object.assign(b.groundTruth!, change); Object.assign(a.groundTruth!, change);
    assert.equal(assessCorrection([b], [a]).eligible, false);
  }
  assert.equal(assessCorrection([], []).eligible, false);
  assert.equal(EVALUATION_GROUPS.length, 6);
});

test("benchmark regions use ground-truth dimensions instead of assuming Canvas and image pixels coincide", () => {
  const before = makeRecord("春の山");
  const record = createOcrBenchmarkRecord({ page: { canvasId: truth.canvasId, imageServiceId: truth.imageServiceId, width: 500, height: 500, image: "", thumbnail: "", label: "", labelTranslations: {}, result: [{ text: "春の山", detectionScore: 1, region: { x: 5, y: 5, width: 10, height: 100 } }] }, manifestUrl: truth.manifestUrl, groundTruth: truth });
  assert.equal(record.metrics!.detection.f1, before.metrics!.detection.f1);
  assert.equal(record.metrics!.raw.cer, 0);
});

test("repeated correlated image variants cannot outvote an equally independent original", () => {
  const original = { text: "春の山", recognitionScore: .9, minimumTokenScore: .8, meanTokenMargin: 2, endedWithEos: true, source: "page" as const, preprocessing: "original" as const, order: 0 };
  const variants = Array.from({ length: 8 }, (_, i) => ({ ...original, text: "花に雲", recognitionScore: .6, preprocessing: "sauvola" as const, order: i + 1 }));
  assert.equal(selectRecognitionCandidate([original, ...variants]).selected.text, "春の山");
});

test("crop URL uses source pixels when Canvas dimensions differ", () => {
  const page = { canvasId: "c", imageServiceId: "https://example.test/iiif", width: 1000, height: 2000, sourceWidth: 4000, sourceHeight: 8000, image: "", thumbnail: "", label: "", labelTranslations: {}, result: [] };
  assert.equal(buildLineCropUrl(page, { width: 500, height: 1000 }, { x: 10, y: 20, width: 10, height: 100 }, { longitudinalRatio: 0, transverseRatio: 0 }), "https://example.test/iiif/80,160,80,800/!1024,1024/0/default.jpg");
});

test("the same padding error at two resolutions does not form independent consensus", () => {
  const original = { text: "第四日以上に", recognitionScore: .4095, minimumTokenScore: .2398, meanTokenMargin: 1.7699, eosScore: .1471, endedWithEos: true, source: "page" as const, preprocessing: "original" as const, order: 0 };
  const padded = { ...original, text: "A" + "E".repeat(90), recognitionScore: .3071, minimumTokenScore: .168, meanTokenMargin: .684, eosScore: .2179, preprocessing: "padded" as const, order: 1 };
  const highRes = { ...padded, text: "A" + "E".repeat(89) + "N", recognitionScore: .2778, minimumTokenScore: .1848, meanTokenMargin: .512, eosScore: .9788, source: "iiif-crop" as const, preprocessing: "high-resolution-padded" as const, order: 2 };
  const selection = selectRecognitionCandidate([original, padded, highRes]);
  assert.equal(selection.selected.text, original.text);
  assert.notEqual(selection.reason, "consensus");
  assert.equal(selection.uncertain, true);
});
