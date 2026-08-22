import type { DecodedRecognition } from "./recognition-score.ts";
import type { OcrRegion } from "./types.ts";

export type OcrProfile = "fast" | "balanced" | "accurate";
export type OcrWritingMode = "auto" | "vertical" | "horizontal";
export const MAX_EXTRA_RECOGNITIONS = 8;

export type NdlOcrOptions = {
  profile: OcrProfile;
  paperFilter: "off" | "soft";
  enableHighResolutionRetry: boolean;
  enableAdaptiveTiling: boolean;
  enableDeskewRetry: boolean;
  enableLongLineSegmentation: boolean;
  maxExtraRecognitions: number;
  writingMode: OcrWritingMode;
  scattered: boolean;
};

export const DEFAULT_NDL_OCR_OPTIONS: NdlOcrOptions = {
  profile: "balanced",
  paperFilter: "off",
  enableHighResolutionRetry: true,
  enableAdaptiveTiling: false,
  enableDeskewRetry: false,
  enableLongLineSegmentation: false,
  maxExtraRecognitions: 2,
  writingMode: "auto",
  scattered: false,
};

export function normalizeNdlOcrOptions(options?: Partial<NdlOcrOptions>): NdlOcrOptions {
  const next = { ...DEFAULT_NDL_OCR_OPTIONS, ...options };
  const profile = next.profile === "fast" || next.profile === "accurate" ? next.profile : "balanced";
  const writingMode = next.writingMode === "vertical" || next.writingMode === "horizontal"
    ? next.writingMode
    : "auto";
  const profileDefaults = {
    enableHighResolutionRetry: profile !== "fast",
    enableAdaptiveTiling: profile === "accurate",
    enableDeskewRetry: profile === "accurate",
    enableLongLineSegmentation: profile === "accurate",
    maxExtraRecognitions: profile === "fast" ? 0 : profile === "accurate" ? 6 : 2,
  };
  return {
    ...next,
    profile,
    writingMode,
    scattered: Boolean(next.scattered),
    enableHighResolutionRetry: options?.enableHighResolutionRetry ?? profileDefaults.enableHighResolutionRetry,
    enableAdaptiveTiling: options?.enableAdaptiveTiling ?? profileDefaults.enableAdaptiveTiling,
    enableDeskewRetry: options?.enableDeskewRetry ?? profileDefaults.enableDeskewRetry,
    enableLongLineSegmentation: options?.enableLongLineSegmentation ?? profileDefaults.enableLongLineSegmentation,
    maxExtraRecognitions: Number.isFinite(options?.maxExtraRecognitions)
      ? Math.min(MAX_EXTRA_RECOGNITIONS, Math.max(0, Math.floor(options?.maxExtraRecognitions as number)))
      : profileDefaults.maxExtraRecognitions,
  };
}

export function detectionThresholdForProfile(profile: OcrProfile): number {
  switch (profile) {
    case "fast":
      return 0.3;
    case "accurate":
      return 0.18;
    case "balanced":
    default:
      return 0.24;
  }
}

export function recognitionRetryThresholdForProfile(profile: OcrProfile): number {
  switch (profile) {
    case "fast":
      return 0.5;
    case "accurate":
      return 0.66;
    case "balanced":
    default:
      return 0.58;
  }
}

export function isRecognitionLowConfidence(
  recognition: DecodedRecognition,
  region: OcrRegion,
  profile: OcrProfile,
): boolean {
  if (!recognition.text.trim()) return true;
  if (!recognition.endedWithEos) return true;
  if (recognition.recognitionScore < recognitionRetryThresholdForProfile(profile)) return true;
  if (recognition.minimumTokenScore < 0.28) return true;
  if (recognition.meanTokenMargin < 0.35) return true;

  const shortSide = Math.max(1, Math.min(region.width, region.height));
  const longSide = Math.max(region.width, region.height);
  return longSide / shortSide >= 8 && recognition.text.length < 2;
}
