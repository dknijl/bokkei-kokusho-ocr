import * as ort from "onnxruntime-web/webgpu";
import type { OcrLine, OcrRegion, ViewerPage } from "./iiif";
import { LocalizedError, type MessageParams } from "./i18n";
import { OCR_PIPELINE_VERSION } from "./ocr/benchmark.ts";
import { DEFAULT_CROP_PADDING, buildLineCropUrl, expandCropRegion, floorCeilCropRegion } from "./ocr/image.ts";
import { globalNms, mergeAdjacentDetections, type Detection } from "./ocr/nms.ts";
import {
  recognitionCandidateFromDecoded,
  selectRecognitionCandidate,
  type RecognitionCandidate,
} from "./ocr/candidates.ts";
import {
  DEFAULT_NDL_OCR_OPTIONS,
  detectionThresholdForProfile,
  isRecognitionLowConfidence,
  normalizeNdlOcrOptions,
  type NdlOcrOptions,
} from "./ocr/profiles.ts";
import { decodeRecognition, type DecodedRecognition } from "./ocr/recognition-score.ts";
import {
  preprocessCanvas,
  rankDeskewAngles,
  releasePreprocessedCanvas,
  transformLineCanvas,
} from "./ocr/preprocessing.ts";
import {
  estimatePaperMask,
  paperScoreForRegion,
  shouldSuppressSoftPaperCandidate,
  type PaperMaskResult,
} from "./ocr/paper-mask.ts";
import {
  combineSegmentRecognitions,
  createLineWindows,
  findSignificantInkGap,
} from "./ocr/line-segmentation.ts";
import { withProviderFallback } from "./ocr/provider-fallback.ts";
import { orderOcrLines } from "./ocr/reading-order.ts";
import {
  createAdaptiveTiles,
  estimateUncoveredInkRegions,
  restoreTileRegion,
} from "./ocr/tiling.ts";
import type { OcrRunStats, RecognitionOrientation } from "./ocr/types.ts";
import {
  readOcrModelAsset,
  requestOcrModelStoragePersistence,
  writeOcrModelAsset,
} from "./ocr/model-cache.ts";

export const NDL_MODEL_REF = "master";
const MODEL_ROOT = `https://raw.githubusercontent.com/ndl-lab/ndlkotenocr-lite/${NDL_MODEL_REF}`;
const DETECTOR_URL = `${MODEL_ROOT}/src/model/rtmdet-s-1280x1280.onnx`;
const RECOGNIZER_URL = `${MODEL_ROOT}/src/model/parseq-ndl-32x384-tiny-10.onnx`;
const CHARSET_URL = `${MODEL_ROOT}/src/config/NDLmoji.yaml`;
// The official filename says 1280x1280, but the pinned ONNX graph metadata
// requires [1, 3, 1024, 1024]. The graph shape is authoritative.
const DETECTOR_SIZE = 1024;
const RECOGNIZER_WIDTH = 384;
const RECOGNIZER_HEIGHT = 32;
const OCR_UI_YIELD_INTERVAL = 4;
const MODEL_CACHE_KEY_PREFIX = `ndl-ocr:${NDL_MODEL_REF}:`;

export type NdlOcrStage = "image" | "models" | "detect" | "recognize" | "retry" | "done";
export type NdlOcrProgressKey = "progressStarting" | "progressImage" | "progressModels" | "progressDetect" | "progressRecognize" | "progressRetry" | "progressDone";

export type NdlOcrProgress = {
  stage: NdlOcrStage;
  percent: number;
  messageKey: NdlOcrProgressKey;
  params?: MessageParams;
  completed?: number;
  total?: number;
};

export type NdlOcrResult = {
  imageWidth: number;
  imageHeight: number;
  lines: OcrLine[];
  provider: "WebGPU / WASM" | "WASM";
  revision: string;
  pipelineVersion: string;
  profile: NdlOcrOptions["profile"];
  options: NdlOcrOptions;
  stats: OcrRunStats;
};

type ProgressCallback = (progress: NdlOcrProgress) => void;
type LoadedModels = {
  detector: ort.InferenceSession;
  recognizer: ort.InferenceSession;
  charset: string[];
  provider: NdlOcrResult["provider"];
};

let modelPromise: Promise<LoadedModels> | null = null;
let releaseTimer: number | null = null;
let activeOcrRuns = 0;
let releasePromise: Promise<void> | null = null;

ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException("ocrCancelled", "AbortError");
};

const nextFrame = () => typeof requestAnimationFrame === "function"
  ? new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  : Promise.resolve();

async function createSession(
  url: string,
  useWebGpu: boolean,
  signal?: AbortSignal,
): Promise<ort.InferenceSession> {
  throwIfAborted(signal);
  const model = await loadCachedAsset(url, signal);
  throwIfAborted(signal);
  // Do not initialize WASM alongside WebGPU. The WASM backend probes
  // SharedArrayBuffer even when it is only a fallback provider.
  const executionProviders = useWebGpu ? ["webgpu"] : ["wasm"];
  const session = await ort.InferenceSession.create(model, {
    executionProviders,
    graphOptimizationLevel: "all",
  });
  if (signal?.aborted) {
    await session.release();
    throw new DOMException("ocrCancelled", "AbortError");
  }
  return session;
}

async function loadModels(signal?: AbortSignal): Promise<LoadedModels> {
  const webGpuAvailable = typeof navigator !== "undefined" && "gpu" in navigator;
  requestOcrModelStoragePersistence();

  const createBoth = async (useWebGpu: boolean) => {
    let detector: ort.InferenceSession | undefined;
    let recognizer: ort.InferenceSession | undefined;
    try {
      const results = await Promise.allSettled([
        createSession(DETECTOR_URL, useWebGpu, signal),
        createSession(RECOGNIZER_URL, useWebGpu, signal),
        loadCachedAsset(CHARSET_URL, signal, (status) => new LocalizedError("errorCharsetHttp", { status })),
      ]);
      const detectorResult = results[0];
      const recognizerResult = results[1];
      const charsetResult = results[2];
      if (detectorResult.status === "fulfilled") detector = detectorResult.value;
      if (recognizerResult.status === "fulfilled") recognizer = recognizerResult.value;
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      if (!detector || !recognizer || charsetResult.status !== "fulfilled") {
        throw new Error("NDL OCR model loading returned no sessions.");
      }
      throwIfAborted(signal);

      const yaml = new TextDecoder().decode(charsetResult.value);
      throwIfAborted(signal);
      const match = yaml.match(/charset_train:\s*("(?:\\.|[^"\\])*")/);
      if (!match) throw new LocalizedError("errorCharsetFormat");
      const charset = Array.from(JSON.parse(match[1]) as string);

      return {
        detector,
        recognizer,
        charset,
        provider: useWebGpu ? "WebGPU / WASM" as const : "WASM" as const,
      };
    } catch (error) {
      await Promise.allSettled([
        detector?.release() ?? Promise.resolve(),
        recognizer?.release() ?? Promise.resolve(),
      ]);
      throw error;
    }
  };

  if (webGpuAvailable) {
    return withProviderFallback({
      primary: () => createBoth(true),
      fallback: () => createBoth(false),
      signal,
      onFallback: (error) => console.warn("NDL OCR WebGPU initialization failed; falling back to WASM.", error),
    });
  }

  return createBoth(false);
}

async function loadCachedAsset(
  url: string,
  signal?: AbortSignal,
  createHttpError: (status: number) => Error = (status) => new Error(`OCR model fetch failed with HTTP ${status}.`),
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const key = `${MODEL_CACHE_KEY_PREFIX}${url}`;
  const cached = await readOcrModelAsset(key);
  if (cached) return new Uint8Array(cached);

  let response: Response;
  try {
    response = await fetch(url, { signal, mode: "cors", cache: "no-cache" });
  } catch (error) {
    if (signal?.aborted) throw new DOMException("ocrCancelled", "AbortError");
    throw error;
  }
  if (!response.ok) throw createHttpError(response.status);

  const data = await response.arrayBuffer();
  throwIfAborted(signal);
  await writeOcrModelAsset(key, data);
  throwIfAborted(signal);
  return new Uint8Array(data);
}

async function getModels(signal?: AbortSignal): Promise<LoadedModels> {
  if (!modelPromise) {
    modelPromise = loadModels(signal).catch((error) => {
      modelPromise = null;
      throw error;
    });
  }
  const models = await modelPromise;
  throwIfAborted(signal);
  return models;
}

function disposeTensors(values: ort.InferenceSession.OnnxValueMapType | null): void {
  if (!values) return;
  for (const value of Object.values(values)) {
    if (value instanceof ort.Tensor) value.dispose();
  }
}

function clearNdlOcrModelReleaseTimer(): void {
  if (releaseTimer === null || typeof window === "undefined") return;
  window.clearTimeout(releaseTimer);
  releaseTimer = null;
}

export async function releaseNdlOcrModels(): Promise<void> {
  if (activeOcrRuns > 0) return;
  if (releasePromise) return releasePromise;

  const pendingModels = modelPromise;
  if (!pendingModels) return;

  const releasing = (async () => {
    try {
      const models = await pendingModels;
      if (activeOcrRuns > 0 || modelPromise !== pendingModels) return;
      const results = await Promise.allSettled([
        models.detector.release(),
        models.recognizer.release(),
      ]);
      results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .forEach((result) => console.warn("NDL OCR model release failed.", result.reason));
    } catch (error) {
      console.warn("NDL OCR model release failed.", error);
    } finally {
      if (modelPromise === pendingModels) modelPromise = null;
    }
  })();

  releasePromise = releasing;
  try {
    await releasing;
  } finally {
    if (releasePromise === releasing) releasePromise = null;
  }
}

export function scheduleNdlOcrModelRelease(): void {
  if (typeof window === "undefined") return;
  clearNdlOcrModelReleaseTimer();
  releaseTimer = window.setTimeout(() => {
    releaseTimer = null;
    void releaseNdlOcrModels();
  }, 120_000);
}

const imageBlobPromises = new Map<string, Promise<Blob>>();

function fetchImageBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const pending = imageBlobPromises.get(url);
  if (pending) {
    return pending.then((blob) => {
      throwIfAborted(signal);
      return blob;
    });
  }

  const request = (async () => {
    let response: Response;
    try {
      response = await fetch(url, { signal, mode: "cors", cache: "force-cache" });
    } catch (error) {
      if (signal?.aborted) throw new DOMException("ocrCancelled", "AbortError");
      throw new LocalizedError("errorImageFetch", { detail: error instanceof Error ? ` (${error.message})` : "" });
    }
    if (!response.ok) throw new LocalizedError("errorImageHttp", { status: response.status });
    return response.blob();
  })();
  imageBlobPromises.set(url, request);
  void request.then(
    () => {
      if (imageBlobPromises.get(url) === request) imageBlobPromises.delete(url);
    },
    () => {
      if (imageBlobPromises.get(url) === request) imageBlobPromises.delete(url);
    },
  );
  return request.then((blob) => {
    throwIfAborted(signal);
    return blob;
  });
}

async function loadImage(url: string, signal?: AbortSignal): Promise<ImageBitmap> {
  try {
    const blob = await fetchImageBlob(url, signal);
    throwIfAborted(signal);
    const bitmap = await createImageBitmap(blob);
    if (signal?.aborted) {
      bitmap.close();
      throw new DOMException("ocrCancelled", "AbortError");
    }
    return bitmap;
  } catch (error) {
    if (signal?.aborted) throw new DOMException("ocrCancelled", "AbortError");
    throw error;
  }
}

function imageBitmapCanvas(bitmap: ImageBitmap): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  try {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new LocalizedError("errorCanvasInit");
    context.drawImage(bitmap, 0, 0);
    return canvas;
  } catch (error) {
    canvas.width = 0;
    canvas.height = 0;
    throw error;
  }
}

function detectorInput(source: HTMLCanvasElement): { tensor: ort.Tensor; paddedSize: number } {
  const paddedSize = Math.max(source.width, source.height);
  const square = document.createElement("canvas");
  square.width = paddedSize;
  square.height = paddedSize;
  const resized = document.createElement("canvas");
  resized.width = DETECTOR_SIZE;
  resized.height = DETECTOR_SIZE;
  try {
    const squareContext = square.getContext("2d");
    if (!squareContext) throw new LocalizedError("errorDetectionCanvas");
    squareContext.fillStyle = "#000";
    squareContext.fillRect(0, 0, paddedSize, paddedSize);
    squareContext.drawImage(source, 0, 0);

    const context = resized.getContext("2d", { willReadFrequently: true });
    if (!context) throw new LocalizedError("errorDetectionCanvas");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(square, 0, 0, DETECTOR_SIZE, DETECTOR_SIZE);
    const pixels = context.getImageData(0, 0, DETECTOR_SIZE, DETECTOR_SIZE).data;
    const plane = DETECTOR_SIZE * DETECTOR_SIZE;
    const data = new Float32Array(plane * 3);

    for (let index = 0; index < plane; index += 1) {
      const pixel = index * 4;
      data[index] = (pixels[pixel + 2] - 103.53) / 57.375;
      data[plane + index] = (pixels[pixel + 1] - 116.28) / 57.12;
      data[(plane * 2) + index] = (pixels[pixel] - 123.675) / 58.395;
    }

    return {
      tensor: new ort.Tensor("float32", data, [1, 3, DETECTOR_SIZE, DETECTOR_SIZE]),
      paddedSize,
    };
  } finally {
    square.width = 0;
    square.height = 0;
    resized.width = 0;
    resized.height = 0;
  }
}

function decodeDetections(
  outputs: ort.InferenceSession.OnnxValueMapType,
  paddedSize: number,
  imageWidth: number,
  imageHeight: number,
  threshold: number,
): Detection[] {
  const tensors = Object.values(outputs).filter((value): value is ort.Tensor => value instanceof ort.Tensor);
  const boxes = tensors.find((tensor) => tensor.dims.at(-1) === 5);
  if (!boxes) throw new LocalizedError("errorDetectionOutput");

  const values = boxes.data as Float32Array;
  const scale = paddedSize / DETECTOR_SIZE;
  const detections: Detection[] = [];

  for (let offset = 0; offset + 4 < values.length; offset += 5) {
    const score = values[offset + 4];
    if (!Number.isFinite(score) || score <= threshold) continue;

    const rawX1 = values[offset] * scale;
    const rawY1 = values[offset + 1] * scale;
    const rawX2 = values[offset + 2] * scale;
    const rawY2 = values[offset + 3] * scale;
    const rawWidth = rawX2 - rawX1;
    const rawHeight = rawY2 - rawY1;
    const centerX = rawX1 + (rawWidth / 2);
    const centerY = rawY1 + (rawHeight / 2);
    if (
      rawWidth <= 0
      || rawHeight <= 0
      || centerX < 0
      || centerY < 0
      || centerX >= imageWidth
      || centerY >= imageHeight
    ) continue;
    const yPadding = Math.max(1, (rawY2 - rawY1) * 0.02);
    const x1 = Math.max(0, Math.min(imageWidth, rawX1));
    const y1 = Math.max(0, Math.min(imageHeight, rawY1 - yPadding));
    const x2 = Math.max(0, Math.min(imageWidth, rawX2));
    const y2 = Math.max(0, Math.min(imageHeight, rawY2 + yPadding));
    const width = x2 - x1;
    const height = y2 - y1;
    const retainedAreaRatio = (width * height) / (rawWidth * (rawHeight + (yPadding * 2)));

    if (width < 4 || height < 4 || retainedAreaRatio < 0.65) continue;
    detections.push({ x: x1, y: y1, width, height, detectionScore: score });
  }

  return globalNms(detections);
}

async function detectOnCanvas(
  source: HTMLCanvasElement,
  models: LoadedModels,
  threshold: number,
  signal?: AbortSignal,
  onInference?: () => void,
): Promise<Detection[]> {
  throwIfAborted(signal);
  const { tensor, paddedSize } = detectorInput(source);
  let outputs: ort.InferenceSession.OnnxValueMapType | null = null;
  try {
    onInference?.();
    outputs = await models.detector.run({ [models.detector.inputNames[0]]: tensor });
    throwIfAborted(signal);
    return decodeDetections(outputs, paddedSize, source.width, source.height, threshold);
  } finally {
    tensor.dispose();
    disposeTensors(outputs);
  }
}

function recognizerInput(
  source: HTMLCanvasElement,
  region: OcrRegion,
  orientation: RecognitionOrientation = "auto",
  deskewAngle = 0,
): ort.Tensor {
  const bounds = floorCeilCropRegion(region, { width: source.width, height: source.height });
  const cropWidth = Math.max(1, bounds.width);
  const cropHeight = Math.max(1, bounds.height);
  const crop = document.createElement("canvas");
  crop.width = cropWidth;
  crop.height = cropHeight;
  let line: HTMLCanvasElement | null = null;
  const resized = document.createElement("canvas");
  resized.width = RECOGNIZER_WIDTH;
  resized.height = RECOGNIZER_HEIGHT;
  try {
    const cropContext = crop.getContext("2d");
    if (!cropContext) throw new LocalizedError("errorRecognitionCanvas");
    cropContext.imageSmoothingEnabled = true;
    cropContext.imageSmoothingQuality = "high";
    cropContext.drawImage(
      source,
      bounds.x,
      bounds.y,
      Math.max(1, bounds.width),
      Math.max(1, bounds.height),
      0,
      0,
      cropWidth,
      cropHeight,
    );

    line = transformLineCanvas(crop, orientation, deskewAngle);

    const context = resized.getContext("2d", { willReadFrequently: true });
    if (!context) throw new LocalizedError("errorRecognitionCanvas");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.fillStyle = "#fff";
    context.fillRect(0, 0, RECOGNIZER_WIDTH, RECOGNIZER_HEIGHT);
    context.drawImage(line, 0, 0, RECOGNIZER_WIDTH, RECOGNIZER_HEIGHT);

    const pixels = context.getImageData(0, 0, RECOGNIZER_WIDTH, RECOGNIZER_HEIGHT).data;
    const plane = RECOGNIZER_WIDTH * RECOGNIZER_HEIGHT;
    const data = new Float32Array(plane * 3);
    for (let index = 0; index < plane; index += 1) {
      const pixel = index * 4;
      data[index] = (pixels[pixel + 2] / 127.5) - 1;
      data[plane + index] = (pixels[pixel + 1] / 127.5) - 1;
      data[(plane * 2) + index] = (pixels[pixel] / 127.5) - 1;
    }
    return new ort.Tensor("float32", data, [1, 3, RECOGNIZER_HEIGHT, RECOGNIZER_WIDTH]);
  } finally {
    crop.width = 0;
    crop.height = 0;
    releasePreprocessedCanvas(line);
    resized.width = 0;
    resized.height = 0;
  }
}

function lineCanvas(source: HTMLCanvasElement, region: OcrRegion): HTMLCanvasElement {
  const bounds = floorCeilCropRegion(region, { width: source.width, height: source.height });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, bounds.width);
  canvas.height = Math.max(1, bounds.height);
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new LocalizedError("errorRecognitionCanvas");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      source,
      bounds.x,
      bounds.y,
      Math.max(1, bounds.width),
      Math.max(1, bounds.height),
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return canvas;
  } catch (error) {
    canvas.width = 0;
    canvas.height = 0;
    throw error;
  }
}

function luminance(red: number, green: number, blue: number): number {
  return (red * 0.299) + (green * 0.587) + (blue * 0.114);
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 255;
  const sorted = values.slice().sort((first, second) => first - second);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)))] ?? 255;
}

function inkProjection(
  source: HTMLCanvasElement,
  region: OcrRegion,
): { projection: number[]; transverseSize: number; longitudinalStep: number } | null {
  const bounds = floorCeilCropRegion(region, { width: source.width, height: source.height });
  const vertical = bounds.height >= bounds.width;
  const longitudinalSize = vertical ? bounds.height : bounds.width;
  const transverseSize = vertical ? bounds.width : bounds.height;
  if (longitudinalSize < transverseSize * 8 || transverseSize < 4) return null;

  const context = source.getContext("2d", { willReadFrequently: true });
  if (!context || bounds.width <= 0 || bounds.height <= 0) return null;
  const pixels = context.getImageData(bounds.x, bounds.y, bounds.width, bounds.height).data;
  const longitudinalStep = Math.max(1, Math.ceil(longitudinalSize / 800));
  const transverseStep = Math.max(1, Math.ceil(transverseSize / 64));
  const samples: number[] = [];
  const sampleLuminance = (longitudinal: number, transverse: number): number => {
    const x = vertical ? transverse : longitudinal;
    const y = vertical ? longitudinal : transverse;
    const offset = ((Math.min(bounds.height - 1, y) * bounds.width) + Math.min(bounds.width - 1, x)) * 4;
    return luminance(pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0);
  };

  for (let longitudinal = 0; longitudinal < longitudinalSize; longitudinal += longitudinalStep) {
    for (let transverse = 0; transverse < transverseSize; transverse += transverseStep) {
      samples.push(sampleLuminance(longitudinal, transverse));
    }
  }
  const background = percentile(samples, 0.82);
  const low = percentile(samples, 0.2);
  const darknessScale = Math.max(14, (background - low) * 0.2);
  const projection: number[] = [];
  const transverseSamples = Math.max(1, Math.ceil(transverseSize / transverseStep));
  for (let longitudinal = 0; longitudinal < longitudinalSize; longitudinal += longitudinalStep) {
    let darkness = 0;
    for (let transverse = 0; transverse < transverseSize; transverse += transverseStep) {
      darkness += Math.min(1, Math.max(0, (background - sampleLuminance(longitudinal, transverse)) / darknessScale));
    }
    projection.push(darkness / transverseSamples);
  }

  return {
    projection,
    transverseSize: transverseSize / longitudinalStep,
    longitudinalStep,
  };
}

function splitDetectionAtInkGap(source: HTMLCanvasElement, detection: Detection): Detection[] {
  const vertical = detection.height >= detection.width;
  const longitudinalSize = vertical ? detection.height : detection.width;
  const transverseSize = Math.max(1, vertical ? detection.width : detection.height);
  if (longitudinalSize / transverseSize < 8) return [detection];
  const projection = inkProjection(source, detection);
  if (!projection) return [detection];
  const gap = findSignificantInkGap(projection.projection, projection.transverseSize, {
    minimumGapRatio: 0.65,
    minimumSegmentRatio: 2.2,
    maximumShortSegmentRatio: 0.55,
    activityThreshold: 0.035,
  });
  if (!gap) return [detection];

  const localStart = gap.start * projection.longitudinalStep;
  const localEnd = Math.min(longitudinalSize, gap.end * projection.longitudinalStep);
  const firstLongitudinalSize = localStart;
  const secondLongitudinalStart = localEnd;
  const secondLongitudinalSize = longitudinalSize - secondLongitudinalStart;
  if (
    firstLongitudinalSize < transverseSize * 2.2
    || secondLongitudinalSize < transverseSize * 2.2
  ) return [detection];

  if (vertical) {
    return [
      { ...detection, height: firstLongitudinalSize },
      { ...detection, y: detection.y + secondLongitudinalStart, height: secondLongitudinalSize },
    ];
  }
  return [
    { ...detection, width: firstLongitudinalSize },
    { ...detection, x: detection.x + secondLongitudinalStart, width: secondLongitudinalSize },
  ];
}

function splitDetectionsAtInkGaps(source: HTMLCanvasElement, detections: Detection[]): Detection[] {
  return detections.flatMap((detection) => splitDetectionAtInkGap(source, detection));
}

export function decodeText(
  outputs: ort.InferenceSession.OnnxValueMapType,
  charset: string[],
): DecodedRecognition {
  const tensor = Object.values(outputs).find((value): value is ort.Tensor => value instanceof ort.Tensor);
  if (!tensor || tensor.dims.length < 2) throw new LocalizedError("errorRecognitionOutput");

  const values = tensor.data as ArrayLike<number>;
  const classCount = tensor.dims.at(-1) ?? 0;
  const sequenceLength = tensor.dims.at(-2) ?? 0;
  return decodeRecognition(values, sequenceLength, classCount, charset);
}

export function buildNdlOcrImageUrl(page: ViewerPage): string {
  return page.imageServiceId
    ? `${page.imageServiceId.replace(/\/$/, "")}/full/2000,/0/default.jpg`
    : page.image;
}

async function recognizeCanvasLine(
  source: HTMLCanvasElement,
  region: OcrRegion,
  models: LoadedModels,
  orientation: RecognitionOrientation = "auto",
  deskewAngle = 0,
  signal?: AbortSignal,
): Promise<DecodedRecognition> {
  throwIfAborted(signal);
  const input = recognizerInput(source, region, orientation, deskewAngle);
  let outputs: ort.InferenceSession.OnnxValueMapType | null = null;
  try {
    outputs = await models.recognizer.run({ [models.recognizer.inputNames[0]]: input });
    throwIfAborted(signal);
    return decodeText(outputs, models.charset);
  } finally {
    input.dispose();
    disposeTensors(outputs);
  }
}

export async function recognizePageWithNdlLite(
  page: ViewerPage,
  options: NdlOcrOptions = DEFAULT_NDL_OCR_OPTIONS,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<NdlOcrResult> {
  const normalizedOptions = normalizeNdlOcrOptions(options);
  const startedAt = Date.now();
  const stats: OcrRunStats = {
    detectionCount: 0,
    modelInferenceCount: 0,
    adaptiveTiles: 0,
    initialRecognitions: 0,
    extraRecognitions: 0,
    extraRecognitionAttempts: 0,
    highResolutionRetries: 0,
    additionalCropRequests: 0,
    additionalCropFailures: 0,
    maxCanvasPixels: 0,
    durationMs: 0,
  };
  const recordCanvasPixels = (canvas: HTMLCanvasElement): void => {
    stats.maxCanvasPixels = Math.max(stats.maxCanvasPixels, canvas.width * canvas.height);
  };
  const recognizeTracked = (
    source: HTMLCanvasElement,
    region: OcrRegion,
    models: LoadedModels,
    orientation: RecognitionOrientation,
    deskewAngle: number,
  ): Promise<DecodedRecognition> => {
    stats.modelInferenceCount += 1;
    return recognizeCanvasLine(source, region, models, orientation, deskewAngle, signal);
  };
  const beginExtraRecognition = (): boolean => {
    if (stats.extraRecognitionAttempts >= normalizedOptions.maxExtraRecognitions) return false;
    stats.extraRecognitionAttempts += 1;
    onProgress({
      stage: "retry",
      percent: 72 + Math.round((stats.extraRecognitionAttempts / Math.max(1, normalizedOptions.maxExtraRecognitions)) * 20),
      messageKey: "progressRetry",
      params: { completed: stats.extraRecognitionAttempts, total: normalizedOptions.maxExtraRecognitions },
      completed: stats.extraRecognitionAttempts,
      total: normalizedOptions.maxExtraRecognitions,
    });
    return true;
  };
  clearNdlOcrModelReleaseTimer();
  activeOcrRuns += 1;

  try {
    throwIfAborted(signal);
    onProgress({ stage: "image", percent: 3, messageKey: "progressImage" });
    const bitmap = await loadImage(buildNdlOcrImageUrl(page), signal);
    let source: HTMLCanvasElement;
    try {
      throwIfAborted(signal);
      source = imageBitmapCanvas(bitmap);
      recordCanvasPixels(source);
    } finally {
      bitmap.close();
    }

    try {
      onProgress({ stage: "models", percent: 8, messageKey: "progressModels" });
      const models = await getModels(signal);
      throwIfAborted(signal);

      onProgress({ stage: "detect", percent: 22, messageKey: "progressDetect" });
      const detectionThreshold = detectionThresholdForProfile(normalizedOptions.profile);
      let detections = splitDetectionsAtInkGaps(
        source,
        mergeAdjacentDetections(
          await detectOnCanvas(source, models, detectionThreshold, signal, () => { stats.modelInferenceCount += 1; }),
          { orientation: normalizedOptions.writingMode, maxGapRatio: 1.2, transverseOverlapThreshold: 0.65 },
        ),
      );

      if (normalizedOptions.enableAdaptiveTiling && normalizedOptions.profile !== "fast") {
        const suspiciousRegions = estimateUncoveredInkRegions(source, detections);
        const tiles = createAdaptiveTiles(
          { width: source.width, height: source.height },
          normalizedOptions.profile,
          suspiciousRegions,
        );
        stats.adaptiveTiles = tiles.length;
        for (const tile of tiles) {
          throwIfAborted(signal);
          const tileSource = lineCanvas(source, tile);
          recordCanvasPixels(tileSource);
          try {
            const localDetections = await detectOnCanvas(
              tileSource,
              models,
              detectionThreshold,
              signal,
              () => { stats.modelInferenceCount += 1; },
            );
            detections.push(...localDetections.map((detection) => ({
              ...restoreTileRegion(tile, detection, { width: source.width, height: source.height }),
              detectionScore: detection.detectionScore,
            })));
          } finally {
            tileSource.width = 0;
            tileSource.height = 0;
          }
        }
        detections = splitDetectionsAtInkGaps(
          source,
          mergeAdjacentDetections(
            globalNms(detections),
            { orientation: normalizedOptions.writingMode, maxGapRatio: 1.2, transverseOverlapThreshold: 0.65 },
          ),
        );
      }

      let paperMask: PaperMaskResult = { regions: [], confidence: 0 };
      if (normalizedOptions.paperFilter === "soft") {
        try {
          paperMask = estimatePaperMask(source);
          detections = detections.map((detection) => ({
            ...detection,
            paperScore: paperScoreForRegion(detection, paperMask),
          }));
        } catch (error) {
          console.warn("NDL OCR paper-mask estimation failed; continuing without paper scores.", error);
        }
      }

      throwIfAborted(signal);
      if (!detections.length) throw new LocalizedError("errorNoLines");
      stats.detectionCount = detections.length;

      const lines: OcrLine[] = [];
      for (let index = 0; index < detections.length; index += 1) {
        throwIfAborted(signal);
        const detection = detections[index];
        if (
          index === 0
          || (index + 1) % OCR_UI_YIELD_INTERVAL === 0
          || index === detections.length - 1
        ) {
          onProgress({
            stage: "recognize",
            percent: 28 + Math.round(((index + 1) / detections.length) * 68),
            messageKey: "progressRecognize",
            params: { completed: index + 1, total: detections.length },
            completed: index + 1,
            total: detections.length,
          });
        }
        const original = await recognizeTracked(source, detection, models, "auto", 0);
        stats.initialRecognitions += 1;
        if (
          normalizedOptions.paperFilter === "soft"
          && shouldSuppressSoftPaperCandidate(detection, paperMask, original.text, original.recognitionScore)
        ) {
          continue;
        }
        const candidates: RecognitionCandidate[] = [
          recognitionCandidateFromDecoded(original, {
            source: "page",
            preprocessing: "original",
            order: 0,
            orientation: "auto",
          }),
        ];

        const originalLowConfidence = isRecognitionLowConfidence(original, detection, normalizedOptions.profile);
        const shortSide = Math.max(1, Math.min(detection.width, detection.height));
        const longSide = Math.max(detection.width, detection.height);
        const shouldTryDirection = originalLowConfidence
          && (longSide / shortSide < 1.8 || normalizedOptions.profile === "accurate");

        if (shouldTryDirection && beginExtraRecognition()) {
          try {
            const orientation: RecognitionOrientation = detection.height > detection.width ? "normal" : "rotate-90";
            const direction = await recognizeTracked(source, detection, models, orientation, 0);
            stats.extraRecognitions += 1;
            candidates.push(recognitionCandidateFromDecoded(direction, {
              source: "page",
              preprocessing: "original",
              orientation,
              order: candidates.length,
            }));
          } catch (error) {
            if (signal?.aborted) throw new DOMException("ocrCancelled", "AbortError");
            console.warn("NDL OCR direction retry failed; keeping the original candidate.", error);
          }
        }

        if (originalLowConfidence && beginExtraRecognition()) {
          throwIfAborted(signal);
          const paddedRegion = expandCropRegion(
            detection,
            DEFAULT_CROP_PADDING,
            { width: source.width, height: source.height },
            detections,
          );
          let padded: DecodedRecognition | null = null;
          try {
            padded = await recognizeTracked(source, paddedRegion, models, "auto", 0);
            stats.extraRecognitions += 1;
            candidates.push(recognitionCandidateFromDecoded(padded, {
              source: "page",
              preprocessing: "padded",
              orientation: "auto",
              order: candidates.length,
            }));
          } catch (error) {
            if (signal?.aborted) throw new DOMException("ocrCancelled", "AbortError");
            console.warn("NDL OCR padded retry failed; keeping the original candidate.", error);
          }

          if (
            padded
            && normalizedOptions.enableHighResolutionRetry
            && isRecognitionLowConfidence(padded, detection, normalizedOptions.profile)
            && stats.extraRecognitionAttempts < normalizedOptions.maxExtraRecognitions
          ) {
            const cropUrl = buildLineCropUrl(
              page,
              { width: source.width, height: source.height },
              detection,
              DEFAULT_CROP_PADDING,
              1024,
              detections,
            );
            if (cropUrl && beginExtraRecognition()) {
              stats.additionalCropRequests += 1;
              try {
                throwIfAborted(signal);
                const cropBitmap = await loadImage(cropUrl, signal);
                let cropCanvas: HTMLCanvasElement | null = null;
                try {
                  throwIfAborted(signal);
                  cropCanvas = imageBitmapCanvas(cropBitmap);
                  recordCanvasPixels(cropCanvas);
                  const highResolution = await recognizeTracked(
                    cropCanvas,
                    { x: 0, y: 0, width: cropCanvas.width, height: cropCanvas.height },
                    models,
                    "auto",
                    0,
                  );
                  stats.extraRecognitions += 1;
                  stats.highResolutionRetries += 1;
                  candidates.push(recognitionCandidateFromDecoded(highResolution, {
                    source: "iiif-crop",
                    preprocessing: "high-resolution-original",
                    orientation: "auto",
                    order: candidates.length,
                  }));
                } finally {
                  if (cropCanvas) {
                    cropCanvas.width = 0;
                    cropCanvas.height = 0;
                  }
                  cropBitmap.close();
                }
              } catch (error) {
                if (signal?.aborted) throw new DOMException("ocrCancelled", "AbortError");
                stats.additionalCropFailures += 1;
                console.warn("NDL OCR high-resolution crop failed; keeping page candidates.", error);
              }
            }
          }

          if (
            padded
            && normalizedOptions.enableDeskewRetry
            && isRecognitionLowConfidence(padded, detection, normalizedOptions.profile)
            && stats.extraRecognitionAttempts < normalizedOptions.maxExtraRecognitions
          ) {
            let sourceCrop: HTMLCanvasElement | null = null;
            try {
              sourceCrop = lineCanvas(source, paddedRegion);
              const angle = rankDeskewAngles(sourceCrop, "auto")
                .find((candidate) => Math.abs(candidate) >= 0.001);
              if (angle !== undefined && beginExtraRecognition()) {
                const deskewed = await recognizeTracked(source, detection, models, "auto", angle);
                stats.extraRecognitions += 1;
                candidates.push(recognitionCandidateFromDecoded(deskewed, {
                  source: "page",
                  preprocessing: "original",
                  orientation: "auto",
                  deskewAngle: angle,
                  order: candidates.length,
                }));
              }
            } catch (error) {
              if (signal?.aborted) throw new DOMException("ocrCancelled", "AbortError");
              console.warn("NDL OCR deskew retry failed; keeping existing candidates.", error);
            } finally {
              if (sourceCrop) {
                sourceCrop.width = 0;
                sourceCrop.height = 0;
              }
            }
          }

          if (
            padded
            && normalizedOptions.profile === "accurate"
            && isRecognitionLowConfidence(padded, detection, normalizedOptions.profile)
            && stats.extraRecognitionAttempts < normalizedOptions.maxExtraRecognitions
          ) {
            const preprocessingCandidates = [
              "grayscale-contrast",
              "background-normalized",
              "ink-channel",
              "adaptive-binary",
            ] as const;
            for (const preprocessing of preprocessingCandidates) {
              if (!beginExtraRecognition()) break;
              throwIfAborted(signal);
              let sourceCrop: HTMLCanvasElement | null = null;
              let processed: HTMLCanvasElement | null = null;
              try {
                sourceCrop = lineCanvas(source, paddedRegion);
                recordCanvasPixels(sourceCrop);
                processed = preprocessCanvas(sourceCrop, preprocessing);
                recordCanvasPixels(processed);
                const decoded = await recognizeTracked(
                  processed,
                  { x: 0, y: 0, width: processed.width, height: processed.height },
                  models,
                  "auto",
                  0,
                );
                stats.extraRecognitions += 1;
                candidates.push(recognitionCandidateFromDecoded(decoded, {
                  source: "page",
                  preprocessing,
                  orientation: "auto",
                  order: candidates.length,
                }));
              } catch (error) {
                if (signal?.aborted) throw new DOMException("ocrCancelled", "AbortError");
                console.warn(`NDL OCR ${preprocessing} retry failed; keeping existing candidates.`, error);
              } finally {
                if (sourceCrop) {
                  sourceCrop.width = 0;
                  sourceCrop.height = 0;
                }
                releasePreprocessedCanvas(processed);
              }
            }
          }
        }

        if (
          normalizedOptions.enableLongLineSegmentation
          && (originalLowConfidence || normalizedOptions.profile === "accurate")
          && stats.extraRecognitionAttempts < normalizedOptions.maxExtraRecognitions
        ) {
          const remaining = normalizedOptions.maxExtraRecognitions - stats.extraRecognitionAttempts;
          const windows = createLineWindows(
            detection,
            { width: source.width, height: source.height },
            { maxWindows: Math.min(4, remaining) },
          );
          if (windows.length > 1 && windows.length <= remaining) {
            const segments: Array<{
              text: string;
              recognitionScore: number;
              minimumTokenScore: number;
              meanTokenMargin: number;
              endedWithEos: boolean;
            }> = [];
            let segmentationComplete = true;
            for (const window of windows) {
              if (!beginExtraRecognition()) {
                segmentationComplete = false;
                break;
              }
              throwIfAborted(signal);
              try {
                segments.push(await recognizeTracked(source, window, models, "auto", 0));
                stats.extraRecognitions += 1;
              } catch (error) {
                if (signal?.aborted) throw new DOMException("ocrCancelled", "AbortError");
                segmentationComplete = false;
                console.warn("NDL OCR long-line segment retry failed; keeping the full-line candidate.", error);
                break;
              }
            }
            const segmented = segmentationComplete && segments.length === windows.length
              ? combineSegmentRecognitions(segments)
              : null;
            if (segmented) {
              candidates.push({
                ...segmented,
                source: "segmented",
                preprocessing: "original",
                order: candidates.length,
              });
            }
          }
        }

        const selection = selectRecognitionCandidate(candidates);
        lines.push({
          text: selection.selected.text,
          id: `line-${index}`,
          detectionScore: detection.detectionScore,
          detectionIndex: index,
          recognitionScore: selection.selected.recognitionScore,
          minimumTokenScore: selection.selected.minimumTokenScore,
          meanTokenMargin: selection.selected.meanTokenMargin,
          eosScore: selection.selected.eosScore,
          endedWithEos: selection.selected.endedWithEos,
          source: selection.selected.source,
          preprocessing: selection.selected.preprocessing,
          orientation: selection.selected.orientation,
          deskewAngle: selection.selected.deskewAngle,
          paperScore: detection.paperScore,
          alternatives: selection.alternatives,
          uncertain: selection.uncertain,
          selectionReason: selection.reason,
          region: { x: detection.x, y: detection.y, width: detection.width, height: detection.height },
        });
        if ((index + 1) % OCR_UI_YIELD_INTERVAL === 0 || index === detections.length - 1) {
          await nextFrame();
        }
      }

      const imageWidth = source.width;
      const imageHeight = source.height;
      const orderedLines = orderOcrLines(lines, {
        writingMode: normalizedOptions.writingMode,
        scattered: normalizedOptions.scattered,
      });
      stats.durationMs = Date.now() - startedAt;
      onProgress({
        stage: "done",
        percent: 100,
        messageKey: "progressDone",
        params: { count: lines.length },
        completed: lines.length,
        total: lines.length,
      });
      return {
        imageWidth,
        imageHeight,
        lines: orderedLines,
        provider: models.provider,
        revision: NDL_MODEL_REF,
        pipelineVersion: OCR_PIPELINE_VERSION,
        profile: normalizedOptions.profile,
        options: normalizedOptions,
        stats,
      };
    } finally {
      source.width = 0;
      source.height = 0;
    }
  } finally {
    activeOcrRuns -= 1;
    if (activeOcrRuns === 0) scheduleNdlOcrModelRelease();
  }
}
