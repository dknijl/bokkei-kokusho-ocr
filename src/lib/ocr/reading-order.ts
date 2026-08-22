import type { OcrLine, OcrRegion } from "./types.ts";

export type WritingMode = "vertical" | "horizontal";

export type ReadingOrderOptions = {
  writingMode?: WritingMode | "auto";
  scattered?: boolean;
};

export type OrderedOcrLine = OcrLine & {
  detectionIndex: number;
  readingOrder: number;
};

function center(region: OcrRegion, axis: "x" | "y"): number {
  return (axis === "x" ? region.x : region.y) + (axis === "x" ? region.width : region.height) / 2;
}

function span(region: OcrRegion, axis: "x" | "y"): number {
  return axis === "x" ? region.width : region.height;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

export function inferWritingMode(regions: OcrRegion[]): WritingMode {
  if (!regions.length) return "vertical";
  const verticalCount = regions.filter((region) => region.height > region.width * 1.2).length;
  return verticalCount >= Math.ceil(regions.length / 2) ? "vertical" : "horizontal";
}

function groupByReadingBand(
  regions: OcrRegion[],
  indices: number[],
  mode: WritingMode,
): number[][] {
  const transverseAxis = mode === "vertical" ? "x" : "y";
  const longitudinalAxis = mode === "vertical" ? "y" : "x";
  const bandThreshold = Math.max(4, median(regions.map((region) => span(region, transverseAxis))) * 0.65);
  const bands: number[][] = [];

  for (const index of indices.slice().sort((first, second) =>
    center(regions[first], transverseAxis) - center(regions[second], transverseAxis)
    || center(regions[first], longitudinalAxis) - center(regions[second], longitudinalAxis)
    || first - second,
  )) {
    const itemCenter = center(regions[index], transverseAxis);
    const band = bands.find((candidate) => {
      const candidateCenter = candidate.reduce(
        (sum, candidateIndex) => sum + center(regions[candidateIndex], transverseAxis),
        0,
      ) / candidate.length;
      return Math.abs(candidateCenter - itemCenter) <= bandThreshold;
    });
    if (band) band.push(index);
    else bands.push([index]);
  }

  return bands;
}

function splitLayoutBlocks(
  regions: OcrRegion[],
  indices: number[],
  mode: WritingMode,
): number[][] {
  if (indices.length < 4) return [indices];
  const axis = mode === "vertical" ? "y" : "x";
  const spans = indices.map((index) => span(regions[index], axis));
  const minimumSpan = Math.min(...spans);
  const maximumSpan = Math.max(...spans);
  if (minimumSpan <= 0 || maximumSpan / minimumSpan < 1.8) return [indices];

  const sorted = indices.slice().sort((first, second) =>
    center(regions[first], axis) - span(regions[first], axis) / 2
    - (center(regions[second], axis) - span(regions[second], axis) / 2)
    || first - second,
  );
  const gapThreshold = Math.max(6, minimumSpan * 0.04);
  const cuts: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = regions[sorted[index - 1]];
    const current = regions[sorted[index]];
    const previousEnd = (axis === "y" ? previous.y + previous.height : previous.x + previous.width);
    const currentStart = axis === "y" ? current.y : current.x;
    if (currentStart - previousEnd >= gapThreshold) cuts.push(index);
  }
  if (!cuts.length) return [indices];

  const blocks: number[][] = [];
  let start = 0;
  for (const end of [...cuts, sorted.length]) {
    blocks.push(sorted.slice(start, end));
    start = end;
  }
  return blocks;
}

export function xyCutOrder(
  regions: OcrRegion[],
  options: ReadingOrderOptions = {},
): number[] {
  const indices = regions.map((_, index) => index);
  if (options.scattered || regions.length < 2) return indices;
  const mode = options.writingMode && options.writingMode !== "auto"
    ? options.writingMode
    : inferWritingMode(regions);
  const transverseAxis = mode === "vertical" ? "x" : "y";
  const longitudinalAxis = mode === "vertical" ? "y" : "x";
  return splitLayoutBlocks(regions, indices, mode).flatMap((block) => {
    const bands = groupByReadingBand(regions, block, mode);
    bands.sort((first, second) => {
      const firstCenter = first.reduce((sum, index) => sum + center(regions[index], transverseAxis), 0) / first.length;
      const secondCenter = second.reduce((sum, index) => sum + center(regions[index], transverseAxis), 0) / second.length;
      return mode === "vertical" ? secondCenter - firstCenter : firstCenter - secondCenter;
    });
    return bands.flatMap((band) => band.slice().sort((first, second) =>
      center(regions[first], longitudinalAxis) - center(regions[second], longitudinalAxis)
      || first - second,
    ));
  });
}

export function orderOcrLines(
  lines: OcrLine[],
  options: ReadingOrderOptions = {},
): OrderedOcrLine[] {
  const order = xyCutOrder(
    lines.map((line) => line.region ?? { x: 0, y: 0, width: 0, height: 0 }),
    options,
  );
  return order.map((lineIndex, readingOrder) => ({
    ...lines[lineIndex],
    detectionIndex: lines[lineIndex]?.detectionIndex ?? lineIndex,
    readingOrder,
  }));
}
