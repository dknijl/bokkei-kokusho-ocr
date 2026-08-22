import type { OcrLine, OcrRegion } from "./types.ts";
import { levenshteinDistance } from "./edit-distance.ts";

export type OcrGroundTruthLine = {
  text: string;
  normalizedText?: string;
  region: OcrRegion;
};

export type OcrGroundTruthPage = {
  id: string;
  manifestUrl: string;
  canvasId: string;
  imageServiceId: string;
  width: number;
  height: number;
  lines: OcrGroundTruthLine[];
  tags: Array<
    | "printed"
    | "manuscript"
    | "kana"
    | "kanbun"
    | "marginalia"
    | "spread"
    | "illustrated"
    | "faded"
    | "bleed-through"
  >;
};

export type OcrTextMetrics = {
  cer: number;
  exactLineRate: number;
  totalReferenceCharacters: number;
  totalEditDistance: number;
};

export type DetectionMetrics = {
  truePositive: number;
  predicted: number;
  reference: number;
  recall: number;
  precision: number;
  f1: number;
};

export type OcrPageMetrics = {
  raw: OcrTextMetrics;
  normalized?: OcrTextMetrics;
  detection: DetectionMetrics;
  readingOrderAccuracy: number;
  emptyRate: number;
  lowConfidenceErrorDetectionRate: number;
};

export type OcrRegionMatch = {
  predictedIndex: number;
  referenceIndex: number;
  iou: number;
};

function area(region: OcrRegion): number {
  return Math.max(0, region.width) * Math.max(0, region.height);
}

function intersectionArea(first: OcrRegion, second: OcrRegion): number {
  const width = Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x),
  );
  const height = Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y),
  );
  return width * height;
}

function iou(first: OcrRegion, second: OcrRegion): number {
  const intersection = intersectionArea(first, second);
  const union = area(first) + area(second) - intersection;
  return union > 0 ? intersection / union : 0;
}

export function matchOcrRegions(
  predicted: OcrLine[],
  reference: OcrGroundTruthLine[],
  iouThreshold = 0.1,
): OcrRegionMatch[] {
  const candidates: OcrRegionMatch[] = [];
  predicted.forEach((line, predictedIndex) => {
    if (!line.region) return;
    reference.forEach((truth, referenceIndex) => {
      const overlap = iou(line.region as OcrRegion, truth.region);
      if (overlap >= iouThreshold) candidates.push({ predictedIndex, referenceIndex, iou: overlap });
    });
  });
  candidates.sort((first, second) =>
    second.iou - first.iou
    || first.predictedIndex - second.predictedIndex
    || first.referenceIndex - second.referenceIndex,
  );

  const usedPredictions = new Set<number>();
  const usedReferences = new Set<number>();
  return candidates.filter((candidate) => {
    if (usedPredictions.has(candidate.predictedIndex) || usedReferences.has(candidate.referenceIndex)) return false;
    usedPredictions.add(candidate.predictedIndex);
    usedReferences.add(candidate.referenceIndex);
    return true;
  });
}

export function calculateCer(reference: string, prediction: string): number {
  const referenceLength = Array.from(reference).length;
  return referenceLength ? levenshteinDistance(reference, prediction) / referenceLength : prediction ? 1 : 0;
}

export function calculateTextMetrics(
  predicted: OcrLine[],
  reference: OcrGroundTruthLine[],
  matches: OcrRegionMatch[],
  normalize: (value: string) => string = (value) => value,
): OcrTextMetrics {
  const matchedByReference = new Map(matches.map((match) => [match.referenceIndex, match.predictedIndex]));
  let totalReferenceCharacters = 0;
  let totalEditDistance = 0;
  let exactLines = 0;

  reference.forEach((truth, referenceIndex) => {
    const predictionIndex = matchedByReference.get(referenceIndex);
    const prediction = predictionIndex === undefined ? "" : predicted[predictionIndex]?.text ?? "";
    const expectedText = normalize(truth.normalizedText ?? truth.text);
    const actualText = normalize(prediction);
    totalReferenceCharacters += Array.from(expectedText).length;
    totalEditDistance += levenshteinDistance(expectedText, actualText);
    if (expectedText === actualText) exactLines += 1;
  });

  const matchedPredictions = new Set(matches.map((match) => match.predictedIndex));
  predicted.forEach((line, predictedIndex) => {
    if (matchedPredictions.has(predictedIndex)) return;
    totalEditDistance += Array.from(normalize(line.text)).length;
  });

  return {
    cer: totalReferenceCharacters ? totalEditDistance / totalReferenceCharacters : totalEditDistance ? 1 : 0,
    exactLineRate: reference.length ? exactLines / reference.length : 0,
    totalReferenceCharacters,
    totalEditDistance,
  };
}

export function calculateDetectionMetrics(
  predicted: OcrLine[],
  reference: OcrGroundTruthLine[],
  matches: OcrRegionMatch[],
): DetectionMetrics {
  const truePositive = matches.length;
  const recall = reference.length ? truePositive / reference.length : 0;
  const precision = predicted.length ? truePositive / predicted.length : 0;
  return {
    truePositive,
    predicted: predicted.length,
    reference: reference.length,
    recall,
    precision,
    f1: recall + precision ? (2 * recall * precision) / (recall + precision) : 0,
  };
}

export function evaluateOcrPage(options: {
  predicted: OcrLine[];
  reference: OcrGroundTruthPage | OcrGroundTruthLine[];
  normalizedText?: (value: string) => string;
  iouThreshold?: number;
  lowConfidenceThreshold?: number;
}): OcrPageMetrics {
  const referenceLines = Array.isArray(options.reference) ? options.reference : options.reference.lines;
  const matches = matchOcrRegions(options.predicted, referenceLines, options.iouThreshold ?? 0.1);
  const raw = calculateTextMetrics(options.predicted, referenceLines, matches);
  const normalized = options.normalizedText
    ? calculateTextMetrics(options.predicted, referenceLines, matches, options.normalizedText)
    : undefined;
  const matchedByPrediction = new Map(matches.map((match) => [match.predictedIndex, match.referenceIndex]));
  const readingOrder = matches
    .slice()
    .sort((first, second) =>
      (options.predicted[first.predictedIndex]?.readingOrder ?? first.predictedIndex)
      - (options.predicted[second.predictedIndex]?.readingOrder ?? second.predictedIndex)
      || first.predictedIndex - second.predictedIndex,
    )
    .map((match) => match.referenceIndex);
  let orderedPairs = 0;
  let correctlyOrderedPairs = 0;
  for (let first = 0; first < readingOrder.length; first += 1) {
    for (let second = first + 1; second < readingOrder.length; second += 1) {
      orderedPairs += 1;
      if ((readingOrder[first] ?? 0) < (readingOrder[second] ?? 0)) correctlyOrderedPairs += 1;
    }
  }
  const readingOrderAccuracy = readingOrder.length <= 1
    ? (readingOrder.length ? 1 : 0)
    : orderedPairs ? correctlyOrderedPairs / orderedPairs : 0;
  const emptyRate = options.predicted.length
    ? options.predicted.filter((line) => !line.text.trim()).length / options.predicted.length
    : 0;
  const lowConfidenceThreshold = options.lowConfidenceThreshold ?? 0.58;
  const errorPredictions = new Set<number>();
  options.predicted.forEach((line, predictedIndex) => {
    const referenceIndex = matchedByPrediction.get(predictedIndex);
    if (referenceIndex === undefined || line.text !== referenceLines[referenceIndex]?.text) {
      errorPredictions.add(predictedIndex);
    }
  });
  const lowConfidenceErrors = [...errorPredictions].filter((predictedIndex) => {
    const line = options.predicted[predictedIndex];
    return line && (
      line.uncertain === true
      || line.recognitionScore === undefined
      || line.recognitionScore < lowConfidenceThreshold
      || line.endedWithEos === false
    );
  }).length;
  const missingReferenceErrors = referenceLines.reduce((count, truth, referenceIndex) => {
    const match = matches.find((candidate) => candidate.referenceIndex === referenceIndex);
    return count + (match === undefined ? 1 : 0);
  }, 0);
  const totalErrors = errorPredictions.size + missingReferenceErrors;

  return {
    raw,
    ...(normalized ? { normalized } : {}),
    detection: calculateDetectionMetrics(options.predicted, referenceLines, matches),
    readingOrderAccuracy,
    emptyRate,
    lowConfidenceErrorDetectionRate: totalErrors ? lowConfidenceErrors / totalErrors : 0,
  };
}
