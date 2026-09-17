import type { OcrLine } from './types.ts';
import { recognitionRetryThresholdForProfile, type OcrProfile } from './profiles.ts';

export type ConfidencePresentation = {
  reviewNeeded: boolean;
  kind: 'parseq-token' | 'autoregressive-token';
  percent?: number;
  stopReason?: OcrLine['stopReason'];
};

export function isAutoregressiveLine(line: OcrLine): boolean {
  return line.confidenceKind === 'autoregressive-token' || line.recognizerId === 'honkoku-v19';
}

export function confidencePresentation(line: OcrLine, profile: OcrProfile): ConfidencePresentation {
  if (isAutoregressiveLine(line)) {
    return {
      kind: 'autoregressive-token',
      // No score threshold or probability-to-percent conversion before calibration.
      reviewNeeded: !line.text.trim() || line.stopReason !== 'eos'
        || line.endedWithEos === false || line.uncertain === true,
      stopReason: line.stopReason,
    };
  }
  const score = line.recognitionScore;
  const valid = score !== undefined && Number.isFinite(score) && score >= 0 && score <= 1;
  return {
    kind: 'parseq-token',
    reviewNeeded: !valid || score < recognitionRetryThresholdForProfile(profile)
      || line.minimumTokenScore !== undefined && line.minimumTokenScore < 0.28
      || line.meanTokenMargin !== undefined && line.meanTokenMargin < 0.35
      || line.endedWithEos === false || line.uncertain === true,
    ...(valid ? { percent: Math.round(score * 100) } : {}),
  };
}

/** Detection confidence must never substitute for missing recognition confidence. */
export function recognitionAveragePercent(lines: readonly OcrLine[]): number | undefined {
  if (!lines.length || lines.some((line) => isAutoregressiveLine(line)
    || line.recognitionScore === undefined || !Number.isFinite(line.recognitionScore)
    || line.recognitionScore < 0 || line.recognitionScore > 1)) return undefined;
  return Math.round(lines.reduce((sum, line) => sum + line.recognitionScore!, 0) / lines.length * 100);
}

/** Model self-confidence on a 0–100 scale, not calibrated recognition accuracy. */
export function generationScore(line: OcrLine): number | undefined {
  if (!isAutoregressiveLine(line) || line.meanLogProbability === undefined
    || !Number.isFinite(line.meanLogProbability) || line.meanLogProbability > 0
    || !Number.isSafeInteger(line.generatedTokens) || (line.generatedTokens ?? 0) <= 0) return undefined;
  return 100 * Math.exp(line.meanLogProbability);
}

/** Pool token log probabilities; never mix generation and PARSeq scores or omit missing lines. */
export function generationAverageScore(lines: readonly OcrLine[]): number | undefined {
  if (!lines.length || lines.some(line => generationScore(line) === undefined)) return undefined;
  const tokens = lines.reduce((sum, line) => sum + line.generatedTokens!, 0);
  if (!Number.isSafeInteger(tokens)) return undefined;
  const logSum = lines.reduce((sum, line) => sum + line.meanLogProbability! * line.generatedTokens!, 0);
  return 100 * Math.exp(logSum / tokens);
}
