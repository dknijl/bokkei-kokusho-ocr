import type { NdlOcrOptions } from "./profiles.ts";
import type { ImageQuality } from "./preprocessing.ts";

export type RetryKind = "high-resolution" | "padded" | "direction" | "deskew" | "segmented" | "background-normalized" | "grayscale-contrast" | "sauvola" | "adaptive-binary";
export type RetryTarget = {
  index: number;
  score: number;
  lowConfidence: boolean;
  shortSide: number;
  aspectRatio: number;
  quality: ImageQuality;
};

// Empty until held-out, book-disjoint evidence passes the acceptance gate.
// Adding a method requires a checked-in evaluation report for this policy version.
export const APPROVED_IMAGE_CORRECTIONS: readonly RetryKind[] = [];

export function retryCandidates(target: RetryTarget, options: NdlOcrOptions, highResolutionAvailable: boolean): RetryKind[] {
  if (options.benchmarkPreprocessing) return [options.benchmarkPreprocessing];
  const problematic = target.lowConfidence || target.shortSide < 24 || target.quality.contrast < 25 || target.quality.backgroundVariation > 30;
  if (!problematic || options.profile === "fast") return [];
  const kinds: RetryKind[] = [];
  if (options.enableHighResolutionRetry && highResolutionAvailable && target.shortSide < 48) kinds.push("high-resolution");
  if (target.aspectRatio < 1.8) kinds.push("direction");
  kinds.push("padded");
  if (options.enableHighResolutionRetry && highResolutionAvailable && !kinds.includes("high-resolution")) kinds.push("high-resolution");
  if (options.preprocessing === "auto") {
    const corrections: RetryKind[] = target.quality.backgroundVariation > 20
      ? ["background-normalized", "sauvola"] : ["grayscale-contrast", "sauvola"];
    kinds.push(...corrections.filter((kind) => APPROVED_IMAGE_CORRECTIONS.includes(kind)));
  }
  if (options.enableDeskewRetry) kinds.push("deskew");
  if (options.enableLongLineSegmentation && target.aspectRatio >= 16) kinds.push("segmented");
  return kinds;
}

/** All first choices precede any second choice; order is independent of detector order. */
export function scheduleRetries(targets: RetryTarget[], options: NdlOcrOptions, highResolutionAvailable: boolean): Array<{ index: number; kind: RetryKind }> {
  const ordered = targets.map((target) => ({
    target, kinds: retryCandidates(target, options, highResolutionAvailable),
    priority: (1 - target.score) + Math.max(0, 24 - target.shortSide) / 24 + target.quality.backgroundVariation / 255 + Math.max(0, 40 - target.quality.contrast) / 255,
  })).sort((a, b) => b.priority - a.priority || a.target.index - b.target.index);
  const result: Array<{ index: number; kind: RetryKind }> = [];
  for (let round = 0; round < 8 && result.length < options.maxExtraRecognitions; round++) {
    for (const { target, kinds } of ordered) {
      if (result.length >= options.maxExtraRecognitions) break;
      const kind = kinds[round];
      if (kind) result.push({ index: target.index, kind });
    }
  }
  return result;
}
