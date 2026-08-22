import type { OcrRegion } from "./types.ts";

export type Detection = OcrRegion & {
  detectionScore: number;
  paperScore?: number;
};

export type GlobalNmsOptions = {
  iouThreshold: number;
  overlapOverSmallerThreshold: number;
};

export type AdjacentMergeOptions = {
  orientation?: "auto" | "vertical" | "horizontal";
  maxGapRatio: number;
  transverseOverlapThreshold: number;
};

export const DEFAULT_GLOBAL_NMS_OPTIONS: GlobalNmsOptions = {
  iouThreshold: 0.5,
  overlapOverSmallerThreshold: 0.9,
};

export const DEFAULT_ADJACENT_MERGE_OPTIONS: AdjacentMergeOptions = {
  orientation: "auto",
  maxGapRatio: 1.2,
  transverseOverlapThreshold: 0.65,
};

function area(region: OcrRegion): number {
  return Math.max(0, region.width) * Math.max(0, region.height);
}

export function intersectionArea(first: OcrRegion, second: OcrRegion): number {
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

export function intersectionOverUnion(first: OcrRegion, second: OcrRegion): number {
  const overlap = intersectionArea(first, second);
  const union = area(first) + area(second) - overlap;
  return union > 0 ? overlap / union : 0;
}

export function overlapOverSmaller(first: OcrRegion, second: OcrRegion): number {
  const smaller = Math.min(area(first), area(second));
  return smaller > 0 ? intersectionArea(first, second) / smaller : 0;
}

export function globalNms(
  detections: Detection[],
  options: GlobalNmsOptions = DEFAULT_GLOBAL_NMS_OPTIONS,
): Detection[] {
  const ordered = detections
    .map((detection, index) => ({ detection, index }))
    .sort((first, second) =>
      second.detection.detectionScore - first.detection.detectionScore || first.index - second.index,
    );
  const kept: Detection[] = [];

  for (const item of ordered) {
    const suppressed = kept.some((candidate) =>
      intersectionOverUnion(item.detection, candidate) >= options.iouThreshold
      || overlapOverSmaller(item.detection, candidate) >= options.overlapOverSmallerThreshold,
    );
    if (!suppressed) kept.push(item.detection);
  }

  return kept;
}

function unionDetections(first: Detection, second: Detection): Detection {
  const x1 = Math.min(first.x, second.x);
  const y1 = Math.min(first.y, second.y);
  const x2 = Math.max(first.x + first.width, second.x + second.width);
  const y2 = Math.max(first.y + first.height, second.y + second.height);
  const merged = {
    ...first,
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
    detectionScore: Math.max(first.detectionScore, second.detectionScore),
  };
  const paperScore = first.paperScore === undefined || second.paperScore === undefined
    ? first.paperScore ?? second.paperScore
    : Math.min(first.paperScore, second.paperScore);
  return paperScore === undefined ? merged : { ...merged, paperScore };
}

function inferredOrientation(detections: Detection[]): "vertical" | "horizontal" {
  const vertical = detections.filter((detection) => detection.height >= detection.width * 1.5).length;
  const horizontal = detections.filter((detection) => detection.width >= detection.height * 1.5).length;
  return vertical >= horizontal ? "vertical" : "horizontal";
}

function areAdjacent(
  first: Detection,
  second: Detection,
  orientation: "vertical" | "horizontal",
  options: AdjacentMergeOptions,
): boolean {
  const firstTransverseStart = orientation === "vertical" ? first.x : first.y;
  const firstTransverseEnd = orientation === "vertical" ? first.x + first.width : first.y + first.height;
  const secondTransverseStart = orientation === "vertical" ? second.x : second.y;
  const secondTransverseEnd = orientation === "vertical" ? second.x + second.width : second.y + second.height;
  const transverseOverlap = Math.max(
    0,
    Math.min(firstTransverseEnd, secondTransverseEnd) - Math.max(firstTransverseStart, secondTransverseStart),
  );
  const firstTransverseSize = firstTransverseEnd - firstTransverseStart;
  const secondTransverseSize = secondTransverseEnd - secondTransverseStart;
  const smallerTransverseSize = Math.min(firstTransverseSize, secondTransverseSize);
  if (
    smallerTransverseSize <= 0
    || transverseOverlap / smallerTransverseSize < options.transverseOverlapThreshold
  ) return false;

  const firstLongitudinalStart = orientation === "vertical" ? first.y : first.x;
  const firstLongitudinalEnd = orientation === "vertical" ? first.y + first.height : first.x + first.width;
  const secondLongitudinalStart = orientation === "vertical" ? second.y : second.x;
  const secondLongitudinalEnd = orientation === "vertical" ? second.y + second.height : second.x + second.width;
  const gap = Math.max(
    0,
    Math.max(firstLongitudinalStart, secondLongitudinalStart)
      - Math.min(firstLongitudinalEnd, secondLongitudinalEnd),
  );
  const transverseReference = Math.max(firstTransverseSize, secondTransverseSize);
  return gap <= transverseReference * options.maxGapRatio;
}

/** Merge detector boxes split along the writing direction into one OCR line. */
export function mergeAdjacentDetections(
  detections: Detection[],
  options: AdjacentMergeOptions = DEFAULT_ADJACENT_MERGE_OPTIONS,
): Detection[] {
  if (detections.length < 2) return detections;
  const orientation = options.orientation === "auto"
    ? inferredOrientation(detections)
    : options.orientation ?? inferredOrientation(detections);
  const ordered = [...detections].sort((first, second) =>
    (orientation === "vertical" ? first.y - second.y : first.x - second.x)
    || (orientation === "vertical" ? first.x - second.x : first.y - second.y),
  );
  const merged: Detection[] = [];

  for (const detection of ordered) {
    let current = detection;
    let matchIndex = merged.findIndex((candidate) => areAdjacent(candidate, current, orientation, options));
    while (matchIndex >= 0) {
      current = unionDetections(merged[matchIndex], current);
      merged.splice(matchIndex, 1);
      matchIndex = merged.findIndex((candidate) => areAdjacent(candidate, current, orientation, options));
    }
    merged.push(current);
  }

  return merged;
}
