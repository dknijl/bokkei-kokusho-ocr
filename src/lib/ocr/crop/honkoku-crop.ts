import type { ViewerPage } from "../../iiif.ts";
import type { Detection } from "../nms.ts";
import type { OcrRegion } from "../types.ts";

export const HONKOKU_CROP_MARGIN = 45;
export const HONKOKU_RECOGNITION_MAX_EDGE = 3500;
export const HONKOKU_ASPECT_RATIO_TOLERANCE = 0.02;

export type HonkokuImageSize = { width: number; height: number };

export type HonkokuMappedCrop = {
  region: OcrRegion;
  scaleX: number;
  scaleY: number;
};

export class HonkokuCropError extends Error {
  readonly code: "invalid-size" | "aspect-ratio";
  constructor(
    code: "invalid-size" | "aspect-ratio",
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "HonkokuCropError";
  }
}

export function buildHonkokuRecognitionImageUrl(page: ViewerPage): string {
  return page.imageServiceId
    ? `${page.imageServiceId.replace(/\/$/, "")}/full/${HONKOKU_RECOGNITION_MAX_EDGE},/0/default.jpg`
    : page.image;
}

function assertImageSize(size: HonkokuImageSize, name: string): void {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
    throw new HonkokuCropError("invalid-size", `${name} must have positive dimensions.`);
  }
}

export function mapDetectionToHonkokuCrop(
  detection: Detection,
  detectionImage: HonkokuImageSize,
  recognitionImage: HonkokuImageSize,
): HonkokuMappedCrop {
  assertImageSize(detectionImage, "Detection image");
  assertImageSize(recognitionImage, "Recognition image");
  const scaleX = recognitionImage.width / detectionImage.width;
  const scaleY = recognitionImage.height / detectionImage.height;
  const scaleDifference = Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY);
  if (scaleDifference > HONKOKU_ASPECT_RATIO_TOLERANCE) {
    throw new HonkokuCropError("aspect-ratio", "Detection and recognition images have incompatible aspect ratios.");
  }
  return {
    scaleX,
    scaleY,
    // The upstream crop intentionally expands only upwards, downwards and rightwards.
    region: {
      x: detection.x * scaleX,
      y: detection.y * scaleY - HONKOKU_CROP_MARGIN,
      width: detection.width * scaleX + HONKOKU_CROP_MARGIN,
      height: detection.height * scaleY + (HONKOKU_CROP_MARGIN * 2),
    },
  };
}

export type RgbaImage = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export function roundHonkokuCropRegion(region: OcrRegion): OcrRegion {
  return {
    x: Math.round(region.x),
    y: Math.round(region.y),
    width: Math.max(1, Math.round(region.width)),
    height: Math.max(1, Math.round(region.height)),
  };
}

/** Crop without clamping: pixels outside the source remain white. */
export function cropRgbaImageWithWhitePadding(source: RgbaImage, region: OcrRegion): RgbaImage {
  const bounds = roundHonkokuCropRegion(region);
  const data = new Uint8ClampedArray(bounds.width * bounds.height * 4);
  for (let index = 0; index < bounds.width * bounds.height; index += 1) {
    data[index * 4] = 255;
    data[index * 4 + 1] = 255;
    data[index * 4 + 2] = 255;
    data[index * 4 + 3] = 255;
  }

  const sourceX = Math.max(0, bounds.x);
  const sourceY = Math.max(0, bounds.y);
  const sourceRight = Math.min(source.width, bounds.x + bounds.width);
  const sourceBottom = Math.min(source.height, bounds.y + bounds.height);
  for (let y = sourceY; y < sourceBottom; y += 1) {
    for (let x = sourceX; x < sourceRight; x += 1) {
      const targetX = x - bounds.x;
      const targetY = y - bounds.y;
      const sourceOffset = (y * source.width + x) * 4;
      const targetOffset = (targetY * bounds.width + targetX) * 4;
      data[targetOffset] = source.data[sourceOffset] ?? 255;
      data[targetOffset + 1] = source.data[sourceOffset + 1] ?? 255;
      data[targetOffset + 2] = source.data[sourceOffset + 2] ?? 255;
      data[targetOffset + 3] = source.data[sourceOffset + 3] ?? 255;
    }
  }
  return { width: bounds.width, height: bounds.height, data };
}

export function cropImageDataWithWhitePadding(source: ImageData, region: OcrRegion): ImageData {
  const cropped = cropRgbaImageWithWhitePadding(source, region);
  if (typeof ImageData === "undefined") return cropped as unknown as ImageData;
  return new ImageData(cropped.data as unknown as ImageDataArray, cropped.width, cropped.height);
}
