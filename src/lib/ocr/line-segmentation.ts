import { normalizedEditDistance } from "./edit-distance.ts";
import type { OcrRegion } from "./types.ts";

export type LineWindow = OcrRegion & { index: number };

export type LineWindowOptions = {
  aspectThreshold?: number;
  overlapRatio?: number;
  maxWindows?: number;
};

export type InkGap = {
  start: number;
  end: number;
};

export type InkGapOptions = {
  minimumGapRatio?: number;
  minimumSegmentRatio?: number;
  maximumShortSegmentRatio?: number;
  activityThreshold?: number;
};

export type SegmentedRecognition = {
  text: string;
  recognitionScore: number;
  minimumTokenScore: number;
  meanTokenMargin: number;
  endedWithEos: boolean;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function createLineWindows(
  region: OcrRegion,
  imageSize: { width: number; height: number },
  options: LineWindowOptions = {},
): LineWindow[] {
  const aspectThreshold = options.aspectThreshold ?? 8;
  const overlapRatio = clamp(options.overlapRatio ?? 0.2, 0, 0.75);
  const maxWindows = Math.max(2, Math.floor(options.maxWindows ?? 4));
  const vertical = region.height > region.width;
  const longSize = vertical ? region.height : region.width;
  const shortSize = Math.max(1, vertical ? region.width : region.height);
  if (longSize / shortSize < aspectThreshold) return [{ ...region, index: 0 }];

  const count = Math.min(maxWindows, Math.max(2, Math.ceil(longSize / (shortSize * 4))));
  const windowLength = longSize / (count - (count - 1) * overlapRatio);
  const stride = windowLength * (1 - overlapRatio);
  return Array.from({ length: count }, (_, index) => {
    const start = Math.min(longSize - windowLength, index * stride);
    const next = vertical
      ? { x: region.x, y: region.y + start, width: region.width, height: windowLength }
      : { x: region.x + start, y: region.y, width: windowLength, height: region.height };
    const x1 = clamp(next.x, 0, imageSize.width);
    const y1 = clamp(next.y, 0, imageSize.height);
    const x2 = clamp(next.x + next.width, x1, imageSize.width);
    const y2 = clamp(next.y + next.height, y1, imageSize.height);
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1, index };
  });
}

/** Find a large internal blank run that separates two pieces of a line region. */
export function findSignificantInkGap(
  projection: number[],
  transverseSize: number,
  options: InkGapOptions = {},
): InkGap | null {
  if (projection.length < 3 || transverseSize <= 0) return null;
  const minimumGap = Math.max(8, Math.ceil(transverseSize * (options.minimumGapRatio ?? 0.65)));
  const minimumSegment = Math.max(12, Math.ceil(transverseSize * (options.minimumSegmentRatio ?? 2.2)));
  const maximumShortSegmentRatio = options.maximumShortSegmentRatio ?? 0.55;
  const activityThreshold = options.activityThreshold ?? 0.08;
  const active = projection.map((value) => value >= activityThreshold);
  const gaps: InkGap[] = [];

  let start = -1;
  for (let index = 0; index <= active.length; index += 1) {
    if (index < active.length && !active[index]) {
      if (start < 0) start = index;
      continue;
    }
    if (start >= 0) {
      if (index - start >= minimumGap && start >= minimumSegment && active.length - index >= minimumSegment) {
        gaps.push({ start, end: index });
      }
      start = -1;
    }
  }

  return gaps
    .filter((gap) => {
      const before = gap.start;
      const after = active.length - gap.end;
      return Math.min(before, after) / Math.max(before, after) <= maximumShortSegmentRatio;
    })
    .sort((first, second) =>
      (second.end - second.start) - (first.end - first.start)
      || first.start - second.start,
    )[0] ?? null;
}

function bestOverlap(left: string, right: string): { length: number; distance: number } {
  const leftCharacters = Array.from(left);
  const rightCharacters = Array.from(right);
  const maximum = Math.min(24, leftCharacters.length, rightCharacters.length);
  let best: { length: number; distance: number } | null = null;

  for (let length = 1; length <= maximum; length += 1) {
    const suffix = leftCharacters.slice(-length).join("");
    const prefix = rightCharacters.slice(0, length).join("");
    const distance = normalizedEditDistance(suffix, prefix);
    const allowed = length === 1 ? 0 : 0.34;
    if (distance > allowed) continue;
    if (!best || distance < best.distance - 1e-9 || (Math.abs(distance - best.distance) <= 1e-9 && length > best.length)) {
      best = { length, distance };
    }
  }

  return best ?? { length: 0, distance: 1 };
}

export function mergeSegmentTexts(texts: string[]): string | null {
  if (!texts.length) return null;
  let merged = texts[0] ?? "";
  for (const next of texts.slice(1)) {
    const overlap = bestOverlap(merged, next);
    if (!overlap.length && merged && next) return null;
    merged += Array.from(next).slice(overlap.length).join("");
  }
  return merged;
}

export function combineSegmentRecognitions(
  segments: SegmentedRecognition[],
): SegmentedRecognition | null {
  const text = mergeSegmentTexts(segments.map((segment) => segment.text));
  if (text === null || !segments.length) return null;
  return {
    text,
    recognitionScore: segments.reduce((sum, segment) => sum + segment.recognitionScore, 0) / segments.length,
    minimumTokenScore: Math.min(...segments.map((segment) => segment.minimumTokenScore)),
    meanTokenMargin: segments.reduce((sum, segment) => sum + segment.meanTokenMargin, 0) / segments.length,
    endedWithEos: segments.every((segment) => segment.endedWithEos),
  };
}
