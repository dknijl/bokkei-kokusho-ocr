import test from "node:test";
import assert from "node:assert/strict";
import { lineConfidenceState } from "./engine/confidence.ts";
import { mapDetectionToHonkokuCrop } from "./crop/honkoku-crop.ts";
import { rawKojiToPlainText } from "./koji/plain-text.ts";
import type { OcrLine } from "./types.ts";

test("Honkoku token diagnostics do not become calibrated NDL confidence", () => {
  const line: OcrLine = {
    text: "山", rawKoji: "<ruby>山<rt>やま</rt></ruby>", outputFormat: "koji",
    recognizerId: "honkoku-v18", confidenceKind: "autoregressive-token", confidenceCalibrated: false,
    generatedTokens: 5, stopReason: "eos", meanLogProbability: -0.1, minimumTokenProbability: 0.9,
    detectionScore: 0.9,
  };
  assert.equal(lineConfidenceState(line, "honkoku-v18"), "unknown");
  // Existing plain-text output retains both the base text and its reading.
  assert.equal(rawKojiToPlainText(line.rawKoji!), "山やま");
  const ndl: OcrLine = { text: "山", detectionScore: 0.9, recognitionScore: 0.95 };
  assert.equal(lineConfidenceState(ndl, "ndl-parseq"), "normal");
  assert.equal(lineConfidenceState({ ...ndl, uncertain: true }, "ndl-parseq"), "low");
  assert.equal(lineConfidenceState({ ...ndl, confidenceKind: "unavailable" }, "ndl-parseq"), "unknown");
});

test("Honkoku crops use source-image coordinates and reject incompatible images", () => {
  const box = { x: 1000, y: 1200, width: 200, height: 600, detectionScore: 0.9 };
  const copy = { ...box };
  const mapped = mapDetectionToHonkokuCrop(box, { width: 4000, height: 6000 }, { width: 2000, height: 3000 });
  assert.deepEqual(mapped.region, { x: 500, y: 555, width: 145, height: 390 });
  assert.deepEqual(box, copy);
  assert.throws(() => mapDetectionToHonkokuCrop(box, { width: 4000, height: 6000 }, { width: 2000, height: 2000 }), /aspect ratios/);
});
