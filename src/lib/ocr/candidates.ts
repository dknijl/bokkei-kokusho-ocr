import { levenshteinDistance } from "./edit-distance.ts";
import type { DecodedRecognition } from "./recognition-score.ts";
import type { OcrAlternative, OcrSelectionReason } from "./types.ts";

export type RecognitionCandidate = OcrAlternative & { order: number };

export type SelectedRecognitionCandidate = {
  selected: RecognitionCandidate;
  alternatives: OcrAlternative[];
  uncertain: boolean;
  reason: OcrSelectionReason;
};

export type RecognitionSelectionComparison = {
  consensus: SelectedRecognitionCandidate;
  scoreOnly: RecognitionCandidate;
  differs: boolean;
};

export function recognitionCandidateFromDecoded(
  decoded: DecodedRecognition,
  metadata: Pick<RecognitionCandidate, "source" | "preprocessing" | "order" | "orientation" | "deskewAngle">,
): RecognitionCandidate {
  return {
    text: decoded.text,
    recognitionScore: decoded.recognitionScore,
    minimumTokenScore: decoded.minimumTokenScore,
    meanTokenMargin: decoded.meanTokenMargin,
    eosScore: decoded.eosScore,
    endedWithEos: decoded.endedWithEos,
    source: metadata.source,
    preprocessing: metadata.preprocessing,
    order: metadata.order,
    ...(metadata.orientation ? { orientation: metadata.orientation } : {}),
    ...(metadata.deskewAngle === undefined ? {} : { deskewAngle: metadata.deskewAngle }),
  };
}

function candidateUtility(candidate: RecognitionCandidate): number {
  const marginConfidence = 1 - Math.exp(-Math.max(0, candidate.meanTokenMargin));
  return (candidate.recognitionScore * 0.65)
    + (candidate.minimumTokenScore * 0.2)
    + (marginConfidence * 0.15)
    - (candidate.endedWithEos ? 0 : 0.12)
    - (candidate.text ? 0 : 0.08)
    - ((candidate.eosScore ?? (candidate.endedWithEos ? 1 : 0)) < 0.2 ? 0.04 : 0);
}

/** Reference strategy used by benchmark diagnostics; it intentionally ignores consensus. */
export function selectHighestRecognitionScoreCandidate(
  candidates: RecognitionCandidate[],
): RecognitionCandidate {
  if (!candidates.length) throw new Error("At least one recognition candidate is required.");
  return candidates.slice().sort((first, second) =>
    second.recognitionScore - first.recognitionScore
    || first.order - second.order,
  )[0] as RecognitionCandidate;
}

function sameCluster(first: RecognitionCandidate, second: RecognitionCandidate): boolean {
  const maximumLength = Math.max(Array.from(first.text).length, Array.from(second.text).length);
  if (maximumLength <= 1) return first.text === second.text;
  const allowedDistance = Math.max(1, Math.floor(maximumLength * 0.25));
  return levenshteinDistance(first.text, second.text) <= allowedDistance;
}

export function selectRecognitionCandidate(
  candidates: RecognitionCandidate[],
): SelectedRecognitionCandidate {
  if (!candidates.length) throw new Error("At least one recognition candidate is required.");
  const clusters: RecognitionCandidate[][] = [];
  for (const candidate of candidates) {
    const cluster = clusters.find((items) => items.some((item) => sameCluster(item, candidate)));
    if (cluster) cluster.push(candidate);
    else clusters.push([candidate]);
  }

  const distinctPreprocessings = (cluster: RecognitionCandidate[]) =>
    new Set(cluster.map((candidate) =>
      `${candidate.source}:${candidate.preprocessing}:${candidate.orientation ?? "auto"}:${candidate.deskewAngle ?? 0}`,
    )).size;
  const bestInCluster = (cluster: RecognitionCandidate[]) => cluster
    .slice()
    .sort((first, second) => {
      const utilityDifference = candidateUtility(second) - candidateUtility(first);
      if (Math.abs(utilityDifference) > 1e-9) return utilityDifference;
      const firstOriginal = first.source === "page" && first.preprocessing === "original";
      const secondOriginal = second.source === "page" && second.preprocessing === "original";
      if (firstOriginal !== secondOriginal) return firstOriginal ? -1 : 1;
      return first.order - second.order;
    })[0] as RecognitionCandidate;

  const hasIndependentAgreement = candidates.length > 1
    && clusters.some((cluster) => distinctPreprocessings(cluster) >= 2);
  const selectedCluster = clusters.slice().sort((first, second) => {
    const preprocessDifference = distinctPreprocessings(second) - distinctPreprocessings(first);
    if (preprocessDifference) return preprocessDifference;
    const sizeDifference = second.length - first.length;
    if (sizeDifference) return sizeDifference;
    return candidateUtility(bestInCluster(second)) - candidateUtility(bestInCluster(first));
  })[0] as RecognitionCandidate[];
  const selected = bestInCluster(selectedCluster);
  const selectedUtility = candidateUtility(selected);
  const hasUtilityTie = candidates.some((candidate) =>
    candidate !== selected && Math.abs(candidateUtility(candidate) - selectedUtility) <= 1e-9,
  );
  const reason: OcrSelectionReason = hasIndependentAgreement
    ? "consensus"
    : selected.source === "page" && selected.preprocessing === "original" && hasUtilityTie
      ? "original-tie"
      : "score";

  return {
    selected,
    alternatives: candidates.filter((candidate) => candidate !== selected).map(({ order: _order, ...candidate }) => candidate),
    uncertain: candidates.length > 1 && !hasIndependentAgreement,
    reason,
  };
}

export function compareRecognitionSelectionStrategies(
  candidates: RecognitionCandidate[],
): RecognitionSelectionComparison {
  const consensus = selectRecognitionCandidate(candidates);
  const scoreOnly = selectHighestRecognitionScoreCandidate(candidates);
  return {
    consensus,
    scoreOnly,
    differs: consensus.selected.text !== scoreOnly.text,
  };
}
