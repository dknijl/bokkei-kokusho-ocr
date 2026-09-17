import type { ViewerPage } from "../iiif.ts";
import type { NdlOcrOptions } from "./profiles.ts";
import type { OcrRegion } from "./types.ts";
import { abortCheck, fetchOcrResource, OcrFailure } from "./network.ts";

export type ImageServiceInfo = {
  width: number;
  height: number;
  version: 2 | 3;
  region: boolean;
  resize: boolean;
  confined: boolean;
  maxWidth?: number;
  maxHeight?: number;
  maxArea?: number;
  sizes: Array<{ width: number; height: number }>;
};
export type SourceSegment = { url: string; region: OcrRegion };
export type PageImageSource = {
  width: number;
  height: number;
  serviceId: string;
  info?: ImageServiceInfo;
  segments: SourceSegment[];
  warnings: string[];
};

const positive = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;

export function parseImageServiceInfo(raw: Record<string, unknown>): ImageServiceInfo {
  const width = positive(raw.width), height = positive(raw.height);
  if (!width || !height) throw new Error("IIIF info.json has no valid image dimensions");
  const profiles = Array.isArray(raw.profile) ? raw.profile : [raw.profile];
  const name = profiles.find((item) => typeof item === "string") as string ?? "";
  const details = profiles.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
  const features = [...(Array.isArray(raw.extraFeatures) ? raw.extraFeatures : []), ...(Array.isArray(details?.supports) ? details.supports : [])];
  const level = /level([012])/.exec(name)?.[1] ?? "0";
  const version = /\/image\/3\//.test(JSON.stringify(raw["@context"])) || raw.type === "ImageService3" ? 3 : 2;
  const maxWidth = positive(raw.maxWidth ?? details?.maxWidth);
  return {
    width, height, version,
    region: level !== "0" || features.includes("regionByPx"),
    resize: level !== "0" || features.includes("sizeByW"),
    confined: level === "2" || features.includes("sizeByConfinedWh"),
    maxWidth,
    maxHeight: positive(raw.maxHeight ?? details?.maxHeight) ?? maxWidth,
    maxArea: positive(raw.maxArea ?? details?.maxArea),
    sizes: (Array.isArray(raw.sizes) ? raw.sizes : []).flatMap((size) => {
      if (!size || typeof size !== "object") return [];
      const { width: w, height: h } = size as Record<string, unknown>;
      return positive(w) && positive(h) ? [{ width: w as number, height: h as number }] : [];
    }),
  };
}

export function imageSizeParameter(info: ImageServiceInfo, region: OcrRegion, bound: number): string {
  const ratio = Math.min(1, bound / region.width, bound / region.height,
    (info.maxWidth ?? Infinity) / region.width, (info.maxHeight ?? Infinity) / region.height,
    Math.sqrt((info.maxArea ?? Infinity) / (region.width * region.height)));
  const width = Math.max(1, Math.floor(region.width * ratio));
  const height = Math.max(1, Math.floor(region.height * ratio));
  if (!info.resize) {
    const sizes = info.sizes.filter((size) => size.width <= width && size.height <= height)
      .sort((a, b) => b.width * b.height - a.width * a.height);
    if (sizes[0]) return `${sizes[0].width},${sizes[0].height}`;
    if (ratio === 1) return info.version === 3 ? "max" : "full";
    throw new OcrFailure("IIIF service has no supported size within the OCR image limit", "image");
  }
  return info.confined ? `!${width},${height}` : `${width},`;
}

export function sourceRegionUrl(source: PageImageSource, region: OcrRegion, bound: number): string | null {
  if (!source.info?.region || !source.info.resize) return null;
  const x = Math.max(0, Math.floor(region.x)), y = Math.max(0, Math.floor(region.y));
  const width = Math.max(1, Math.min(source.width, Math.ceil(region.x + region.width)) - x);
  const height = Math.max(1, Math.min(source.height, Math.ceil(region.y + region.height)) - y);
  const bounds = { x, y, width, height };
  return `${source.serviceId}/${x},${y},${width},${height}/${imageSizeParameter(source.info, bounds, bound)}/0/default.jpg`;
}

export function createScrollRegions(width: number, height: number, options: NdlOcrOptions): OcrRegion[] {
  const horizontal = width >= height;
  const long = Math.max(width, height), short = Math.min(width, height);
  if (short <= 0 || long / short < options.scrollAspectRatio) return [{ x: 0, y: 0, width, height }];
  const span = Math.min(long, Math.max(1, Math.floor(short * options.scrollTileSpan)));
  const step = Math.max(1, Math.floor(span * (1 - options.tileOverlap)));
  const regions: OcrRegion[] = [];
  for (let offset = 0; ; offset += step) {
    const start = Math.min(offset, long - span);
    regions.push(horizontal ? { x: start, y: 0, width: span, height } : { x: 0, y: start, width, height: span });
    if (start + span >= long) break;
  }
  return regions;
}

export async function resolvePageImageSource(page: ViewerPage, options: NdlOcrOptions, signal?: AbortSignal): Promise<PageImageSource> {
  const source: PageImageSource = {
    width: page.sourceWidth || page.width,
    height: page.sourceHeight || page.height,
    serviceId: page.imageServiceId.replace(/\/$/, ""),
    segments: [], warnings: [],
  };
  if (source.serviceId) {
    try {
      const response = await fetchOcrResource(`${source.serviceId}/info.json`, { mode: "cors", cache: "force-cache" }, signal);
      source.info = parseImageServiceInfo(await response.json());
      source.width = source.info.width;
      source.height = source.info.height;
    } catch (error) {
      abortCheck(signal);
      source.warnings.push(`Image metadata unavailable; using the manifest image without region retries: ${String(error)}`);
    }
  } else source.warnings.push("No IIIF Image Service; extra resolution is unavailable.");
  if (source.info) {
    const full = { x: 0, y: 0, width: source.width, height: source.height };
    const regions = source.info.region && source.info.resize ? createScrollRegions(source.width, source.height, options) : [full];
    source.segments = regions.map((region) => ({
      region,
      url: regions.length > 1 ? sourceRegionUrl(source, region, options.tileMaxSize) as string
        : `${source.serviceId}/full/${imageSizeParameter(source.info!, full, options.overviewMaxSize)}/0/default.jpg`,
    }));
    if (regions.length === 1 && Math.max(source.width, source.height) / Math.min(source.width, source.height) >= options.scrollAspectRatio) {
      source.warnings.push("This IIIF service cannot supply scroll regions; resolution is limited.");
    }
  } else {
    source.segments = [{ url: page.sourceImage || page.image, region: { x: 0, y: 0, width: source.width, height: source.height } }];
  }
  return source;
}

export function toSourceRegion(region: OcrRegion, segment: OcrRegion, bitmap: { width: number; height: number }): OcrRegion {
  const sx = segment.width / bitmap.width, sy = segment.height / bitmap.height;
  return { x: segment.x + region.x * sx, y: segment.y + region.y * sy, width: region.width * sx, height: region.height * sy };
}

export function toSegmentRegion(region: OcrRegion, segment: OcrRegion, bitmap: { width: number; height: number }): OcrRegion {
  const sx = bitmap.width / segment.width, sy = bitmap.height / segment.height;
  return { x: (region.x - segment.x) * sx, y: (region.y - segment.y) * sy, width: region.width * sx, height: region.height * sy };
}
