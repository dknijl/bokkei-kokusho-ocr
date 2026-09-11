import { recognitionRetryThresholdForProfile, type OcrProfile } from "../profiles.ts";
import type { OcrEngineId, OcrLine } from "../types.ts";

export type LineConfidenceState = "low" | "normal" | "unknown";

export function lineConfidenceState(
  line: OcrLine,
  engineId: OcrEngineId,
  profile: OcrProfile = "balanced",
): LineConfidenceState {
  if (engineId === "honkoku-v18" || line.confidenceKind === "unavailable") return "unknown";
  if (line.recognitionScore === undefined) return "low";
  if (
    line.recognitionScore < recognitionRetryThresholdForProfile(profile)
    || line.minimumTokenScore !== undefined && line.minimumTokenScore < 0.28
    || line.meanTokenMargin !== undefined && line.meanTokenMargin < 0.35
    || line.endedWithEos === false
    || line.uncertain === true
  ) return "low";
  return "normal";
}
