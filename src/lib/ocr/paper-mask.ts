import type { OcrRegion } from "./types.ts";

export type PaperMaskResult = {
  regions: OcrRegion[];
  confidence: number;
};

function luminance(red: number, green: number, blue: number): number {
  return (red * 0.299) + (green * 0.587) + (blue * 0.114);
}

function median(values: number[]): number {
  if (!values.length) return 255;
  const sorted = values.slice().sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)] ?? 255;
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

function regionArea(region: OcrRegion): number {
  return Math.max(0, region.width) * Math.max(0, region.height);
}

export function paperScoreForRegion(region: OcrRegion, mask: PaperMaskResult): number {
  if (!mask.regions.length || !mask.confidence) return 0.5;
  const area = regionArea(region);
  if (!area) return 0;
  return Math.min(1, Math.max(...mask.regions.map((paper) => intersectionArea(region, paper) / area)));
}

export function shouldSuppressSoftPaperCandidate(
  region: OcrRegion,
  mask: PaperMaskResult,
  text: string,
  recognitionScore?: number,
): boolean {
  if (mask.confidence < 0.35 || paperScoreForRegion(region, mask) >= 0.08) return false;
  if (!text.trim()) return true;
  return recognitionScore !== undefined && recognitionScore < 0.25;
}

export function estimatePaperMask(source: HTMLCanvasElement, maxRegions = 8): PaperMaskResult {
  if (source.width <= 0 || source.height <= 0) return { regions: [], confidence: 0 };

  const scale = Math.min(1, 192 / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return { regions: [], confidence: 0 };
    context.drawImage(source, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const borderSamples: number[] = [];
    const step = Math.max(1, Math.floor(Math.min(width, height) / 32));
    for (let x = 0; x < width; x += step) {
      borderSamples.push(luminance(pixels[x * 4] ?? 0, pixels[(x * 4) + 1] ?? 0, pixels[(x * 4) + 2] ?? 0));
      const offset = (((height - 1) * width) + x) * 4;
      borderSamples.push(luminance(pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0));
    }
    for (let y = 0; y < height; y += step) {
      const first = (y * width) * 4;
      const last = ((y * width) + width - 1) * 4;
      borderSamples.push(luminance(pixels[first] ?? 0, pixels[first + 1] ?? 0, pixels[first + 2] ?? 0));
      borderSamples.push(luminance(pixels[last] ?? 0, pixels[last + 1] ?? 0, pixels[last + 2] ?? 0));
    }

    const borderMedian = median(borderSamples);
    const deviations = borderSamples.map((value) => Math.abs(value - borderMedian));
    const threshold = Math.max(18, median(deviations) * 3.5);
    const paper = new Uint8Array(width * height);
    for (let index = 0; index < paper.length; index += 1) {
      const offset = index * 4;
      const value = luminance(pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0);
      if (Math.abs(value - borderMedian) <= threshold) paper[index] = 1;
    }

    const visited = new Uint8Array(paper.length);
    const queue = new Int32Array(paper.length);
    const components: Array<{ area: number; region: OcrRegion }> = [];
    const minimumArea = Math.max(8, width * height * 0.015);
    for (let start = 0; start < paper.length; start += 1) {
      if (!paper[start] || visited[start]) continue;
      let head = 0;
      let tail = 0;
      let componentArea = 0;
      let minX = width;
      let minY = height;
      let maxX = 0;
      let maxY = 0;
      queue[tail++] = start;
      visited[start] = 1;
      while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = Math.floor(index / width);
        componentArea += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        for (const neighbor of [index - 1, index + 1, index - width, index + width]) {
          if (neighbor < 0 || neighbor >= paper.length || visited[neighbor] || !paper[neighbor]) continue;
          const neighborX = neighbor % width;
          if (Math.abs(neighborX - x) > 1) continue;
          visited[neighbor] = 1;
          queue[tail++] = neighbor;
        }
      }
      if (componentArea < minimumArea) continue;
      components.push({
        area: componentArea,
        region: {
          x: minX / scale,
          y: minY / scale,
          width: (maxX - minX + 1) / scale,
          height: (maxY - minY + 1) / scale,
        },
      });
    }

    const selected = components
      .sort((first, second) => second.area - first.area)
      .slice(0, Math.max(1, Math.floor(maxRegions)));
    const coveredArea = selected.reduce((sum, component) => sum + component.area, 0);
    return {
      regions: selected.map((component) => component.region),
      confidence: Math.min(1, coveredArea / Math.max(1, width * height)),
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
