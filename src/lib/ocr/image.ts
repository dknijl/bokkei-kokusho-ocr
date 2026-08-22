import type { ViewerPage } from "../iiif.ts";
import type { CropPadding, OcrRegion } from "./types.ts";

export const DEFAULT_CROP_PADDING: CropPadding = {
  longitudinalRatio: 0.04,
  transverseRatio: 0.08,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function floorCeilCropRegion(
  region: OcrRegion,
  imageSize: { width: number; height: number },
): OcrRegion {
  const width = Math.max(0, Math.floor(imageSize.width));
  const height = Math.max(0, Math.floor(imageSize.height));
  const x1 = clamp(Math.floor(region.x), 0, width);
  const y1 = clamp(Math.floor(region.y), 0, height);
  const x2 = clamp(Math.ceil(region.x + region.width), x1, width);
  const y2 = clamp(Math.ceil(region.y + region.height), y1, height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function transverseClearance(
  region: OcrRegion,
  neighbors: OcrRegion[],
  vertical: boolean,
  side: "before" | "after",
): number {
  const longitudinalStart = vertical ? region.y : region.x;
  const longitudinalEnd = vertical ? region.y + region.height : region.x + region.width;
  const transverseStart = vertical ? region.x : region.y;
  const transverseEnd = vertical ? region.x + region.width : region.y + region.height;
  const clearances = neighbors.flatMap((neighbor) => {
    const neighborLongitudinalStart = vertical ? neighbor.y : neighbor.x;
    const neighborLongitudinalEnd = vertical ? neighbor.y + neighbor.height : neighbor.x + neighbor.width;
    if (
      Math.min(longitudinalEnd, neighborLongitudinalEnd)
      <= Math.max(longitudinalStart, neighborLongitudinalStart)
    ) return [];

    const neighborTransverseStart = vertical ? neighbor.x : neighbor.y;
    const neighborTransverseEnd = vertical ? neighbor.x + neighbor.width : neighbor.y + neighbor.height;
    if (side === "before" && neighborTransverseEnd <= transverseStart) {
      return [transverseStart - neighborTransverseEnd];
    }
    if (side === "after" && neighborTransverseStart >= transverseEnd) {
      return [neighborTransverseStart - transverseEnd];
    }
    return [];
  });

  return clearances.length ? Math.min(...clearances) : Number.POSITIVE_INFINITY;
}

export function expandCropRegion(
  region: OcrRegion,
  padding: CropPadding = DEFAULT_CROP_PADDING,
  imageSize?: { width: number; height: number },
  neighbors: OcrRegion[] = [],
): OcrRegion {
  const vertical = region.height > region.width;
  const longitudinalSize = Math.max(0, vertical ? region.height : region.width);
  const transverseSize = Math.max(0, vertical ? region.width : region.height);
  const longitudinalPadding = longitudinalSize * Math.max(0, padding.longitudinalRatio);
  const transversePadding = transverseSize * Math.max(0, padding.transverseRatio);
  const beforeClearance = transverseClearance(region, neighbors, vertical, "before");
  const afterClearance = transverseClearance(region, neighbors, vertical, "after");
  const beforeTransversePadding = Math.min(transversePadding, beforeClearance / 2);
  const afterTransversePadding = Math.min(transversePadding, afterClearance / 2);

  const xPaddingBefore = vertical ? beforeTransversePadding : longitudinalPadding;
  const xPaddingAfter = vertical ? afterTransversePadding : longitudinalPadding;
  const yPaddingBefore = vertical ? longitudinalPadding : beforeTransversePadding;
  const yPaddingAfter = vertical ? longitudinalPadding : afterTransversePadding;
  const next = {
    x: region.x - xPaddingBefore,
    y: region.y - yPaddingBefore,
    width: region.width + xPaddingBefore + xPaddingAfter,
    height: region.height + yPaddingBefore + yPaddingAfter,
  };

  if (!imageSize) return next;
  const x1 = clamp(next.x, 0, Math.max(0, imageSize.width));
  const y1 = clamp(next.y, 0, Math.max(0, imageSize.height));
  const x2 = clamp(next.x + next.width, x1, Math.max(0, imageSize.width));
  const y2 = clamp(next.y + next.height, y1, Math.max(0, imageSize.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function buildLineCropUrl(
  page: ViewerPage,
  detectedImageSize: { width: number; height: number },
  region: OcrRegion,
  padding: CropPadding = DEFAULT_CROP_PADDING,
  maxSize = 1024,
  neighbors: OcrRegion[] = [],
): string {
  if (!page.imageServiceId || page.width <= 0 || page.height <= 0) return "";
  if (detectedImageSize.width <= 0 || detectedImageSize.height <= 0) return "";

  const expanded = expandCropRegion(region, padding, detectedImageSize, neighbors);
  const detectedBounds = floorCeilCropRegion(expanded, detectedImageSize);
  const scaleX = page.width / detectedImageSize.width;
  const scaleY = page.height / detectedImageSize.height;
  const pageBounds = floorCeilCropRegion({
    x: detectedBounds.x * scaleX,
    y: detectedBounds.y * scaleY,
    width: detectedBounds.width * scaleX,
    height: detectedBounds.height * scaleY,
  }, { width: page.width, height: page.height });
  const size = Math.max(1, Math.floor(maxSize));
  const service = page.imageServiceId.replace(/\/$/, "");
  return `${service}/${pageBounds.x},${pageBounds.y},${pageBounds.width},${pageBounds.height}/!${size},${size}/0/default.jpg`;
}
