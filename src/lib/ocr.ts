import type { ViewerPage } from "./iiif";
import { LocalizedError } from "./i18n";

export const METOM_ENDPOINT = "https://mp.ex.nii.ac.jp/metom/api/predict";
export const KURO_NET_VIEWER = "https://codh.rois.ac.jp/kuronet/iiif-curation-viewer/";

export type CropRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MetomPrediction = {
  character: string;
  probability: number;
};

type MetomResponse = {
  predictions?: Array<[unknown, unknown]>;
  error?: unknown;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function buildIiifCropUrl(page: ViewerPage, region: CropRegion): string {
  if (!page.imageServiceId) {
    throw new LocalizedError("errorCropService");
  }
  if (!page.width || !page.height) {
    throw new LocalizedError("errorCropDimensions");
  }

  const x = clamp(Math.round((region.x / 100) * page.width), 0, page.width - 1);
  const y = clamp(Math.round((region.y / 100) * page.height), 0, page.height - 1);
  const width = clamp(Math.round((region.width / 100) * page.width), 1, page.width - x);
  const height = clamp(Math.round((region.height / 100) * page.height), 1, page.height - y);

  return `${page.imageServiceId.replace(/\/$/, "")}/${x},${y},${width},${height}/!512,512/0/default.jpg`;
}

export function buildKuroNetUrl(manifestUrl: string): string {
  const url = new URL(KURO_NET_VIEWER);
  url.searchParams.set("manifest", manifestUrl);
  return url.toString();
}

export async function recognizeWithMetom(
  imageUrl: string,
  signal?: AbortSignal,
): Promise<MetomPrediction[]> {
  const response = await fetch(METOM_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: imageUrl, k: 10, return_probs: true }),
    signal,
  });

  let payload: MetomResponse;
  try {
    payload = (await response.json()) as MetomResponse;
  } catch {
    throw new LocalizedError("errorMetomNonJson", { status: response.status });
  }

  if (!response.ok) {
    const detail = typeof payload.error === "string" ? `: ${payload.error}` : "";
    throw new LocalizedError("errorMetomFailed", { status: response.status, detail });
  }

  if (!Array.isArray(payload.predictions)) {
    throw new LocalizedError("errorMetomResponse");
  }

  return payload.predictions.flatMap(([character, probability]) =>
    typeof character === "string" && typeof probability === "number"
      ? [{ character, probability }]
      : [],
  );
}
