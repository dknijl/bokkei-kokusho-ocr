import type { OcrProfile } from "./profiles.ts";
import type { OcrRegion } from "./types.ts";

export type PageTile = OcrRegion & { id: string };

export type TileSize = {
  width: number;
  height: number;
};

function overlap(first: OcrRegion, second: OcrRegion): number {
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

function clampRegion(region: OcrRegion, size: TileSize): OcrRegion {
  const x1 = Math.max(0, Math.min(size.width, region.x));
  const y1 = Math.max(0, Math.min(size.height, region.y));
  const x2 = Math.max(x1, Math.min(size.width, region.x + region.width));
  const y2 = Math.max(y1, Math.min(size.height, region.y + region.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function tileLimitForProfile(profile: OcrProfile): number {
  switch (profile) {
    case "accurate":
      return 4;
    case "balanced":
      return 2;
    case "fast":
    default:
      return 0;
  }
}

export function createAdaptiveTiles(
  size: TileSize,
  profile: OcrProfile,
  suspiciousRegions: OcrRegion[],
): PageTile[] {
  const limit = tileLimitForProfile(profile);
  if (!limit || !suspiciousRegions.length || size.width <= 0 || size.height <= 0) return [];

  const verticalPage = size.height > size.width * 1.15;
  const rows = verticalPage ? 3 : 2;
  const columns = verticalPage ? 1 : 2;
  const overlapRatio = 0.15;
  const tileWidth = size.width / columns;
  const tileHeight = size.height / rows;
  const candidates: PageTile[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const region = clampRegion({
        x: column * tileWidth - (column ? tileWidth * overlapRatio : 0),
        y: row * tileHeight - (row ? tileHeight * overlapRatio : 0),
        width: tileWidth * (1 + (column ? overlapRatio : 0) + (column < columns - 1 ? overlapRatio : 0)),
        height: tileHeight * (1 + (row ? overlapRatio : 0) + (row < rows - 1 ? overlapRatio : 0)),
      }, size);
      if (suspiciousRegions.some((suspicious) => overlap(region, suspicious) > 0)) {
        candidates.push({ ...region, id: `${row}-${column}` });
      }
    }
  }

  return candidates
    .sort((first, second) => {
      const firstCoverage = suspiciousRegions.reduce((sum, region) => sum + overlap(first, region), 0);
      const secondCoverage = suspiciousRegions.reduce((sum, region) => sum + overlap(second, region), 0);
      return secondCoverage - firstCoverage || first.id.localeCompare(second.id);
    })
    .slice(0, limit);
}

export function restoreTileRegion(tile: PageTile, localRegion: OcrRegion, pageSize: TileSize): OcrRegion {
  return clampRegion({
    x: tile.x + localRegion.x,
    y: tile.y + localRegion.y,
    width: localRegion.width,
    height: localRegion.height,
  }, pageSize);
}

function luminance(red: number, green: number, blue: number): number {
  return (red * 0.299) + (green * 0.587) + (blue * 0.114);
}

function median(values: number[]): number {
  if (!values.length) return 255;
  const sorted = values.slice().sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)] ?? 255;
}

export function estimateUncoveredInkRegions(
  source: HTMLCanvasElement,
  detections: OcrRegion[],
  maxRegions = 12,
): OcrRegion[] {
  const scale = Math.min(1, 256 / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return [];
    context.drawImage(source, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const luminances: number[] = [];
    for (let index = 0; index < pixels.length; index += 4) {
      luminances.push(luminance(pixels[index], pixels[index + 1], pixels[index + 2]));
    }
    const threshold = Math.min(180, median(luminances) - 18);
    const uncovered = new Uint8Array(width * height);
    for (let index = 0; index < uncovered.length; index += 1) {
      if (luminances[index] >= threshold) continue;
      const x = index % width;
      const y = Math.floor(index / width);
      const covered = detections.some((region) => {
        const x1 = region.x * scale;
        const y1 = region.y * scale;
        const x2 = (region.x + region.width) * scale;
        const y2 = (region.y + region.height) * scale;
        return x >= x1 && x <= x2 && y >= y1 && y <= y2;
      });
      if (!covered) uncovered[index] = 1;
    }

    const visited = new Uint8Array(uncovered.length);
    const regions: Array<{ area: number; region: OcrRegion }> = [];
    const queue = new Int32Array(uncovered.length);
    for (let start = 0; start < uncovered.length; start += 1) {
      if (!uncovered[start] || visited[start]) continue;
      let head = 0;
      let tail = 0;
      let area = 0;
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
        area += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        for (const neighbor of [index - 1, index + 1, index - width, index + width]) {
          if (neighbor < 0 || neighbor >= uncovered.length || visited[neighbor] || !uncovered[neighbor]) continue;
          const neighborX = neighbor % width;
          if (Math.abs(neighborX - x) > 1) continue;
          visited[neighbor] = 1;
          queue[tail++] = neighbor;
        }
      }
      if (area < Math.max(3, width * height * 0.0002)) continue;
      regions.push({
        area,
        region: {
          x: minX / scale,
          y: minY / scale,
          width: (maxX - minX + 1) / scale,
          height: (maxY - minY + 1) / scale,
        },
      });
    }
    return regions
      .sort((first, second) => second.area - first.area)
      .slice(0, maxRegions)
      .map((item) => item.region);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
