import { createOcrCanvas, releaseOcrCanvas, type OcrCanvas } from "./ocr/canvas.ts";
import * as ort from "onnxruntime-web/webgpu";
import type { OcrLine, OcrRegion, ViewerPage } from "./iiif";
import { LocalizedError, type MessageParams } from "./i18n";
import { OCR_PIPELINE_VERSION } from "./ocr/benchmark.ts";
import { DEFAULT_CROP_PADDING, expandCropRegion, floorCeilCropRegion } from "./ocr/image.ts";
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

import { ndlModelRevision } from "./ocr/model-revision.ts";
export { NDL_MODEL_REVISION, NDL_MODEL_REF } from "./ocr/model-revision.ts";
import { yieldOcr, resetCanvasCounters, canvasCounters } from "./ocr/canvas.ts";
import { OcrFailure, fetchOcrResource } from "./ocr/network.ts";
import { resolvePageImageSource, sourceRegionUrl, toSourceRegion, toSegmentRegion } from "./ocr/image-source.ts";
import { measureImageQuality } from "./ocr/preprocessing.ts";
import { mergeSourceDetections } from "./ocr/source-detections.ts";
import { scheduleRetries, type RetryTarget } from "./ocr/retry-policy.ts";
// The official filename says 1280x1280, but the pinned ONNX graph metadata
// requires [1, 3, 1024, 1024]. The graph shape is authoritative.
const DETECTOR_SIZE = 1024;
const RECOGNIZER_WIDTH = 384;
const RECOGNIZER_HEIGHT = 32;

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
  provider: "WebGPU" | "WebGPU / WASM" | "WASM";
  revision: string;
  pipelineVersion: string;
  profile: NdlOcrOptions["profile"];
  options: NdlOcrOptions;
  stats: OcrRunStats;
};

/** Detection boxes and dimensions are in original image pixels; no canvas is retained. */
export type DetectedPage = Pick<NdlOcrResult, "imageWidth" | "imageHeight" | "provider" | "options" | "stats"> & {
  detections: Detection[];
  detectorRevision: string;
};

type ProgressCallback = (progress: NdlOcrProgress) => void;
type LoadedModels = {
  revision: string;
  detector: ort.InferenceSession;
  recognizer?: ort.InferenceSession;
  charset: string[];
  provider: NdlOcrResult["provider"];
};

let modelPromise: Promise<LoadedModels> | null = null;
let loadedRevision: string | null = null;
let loadedRecognition = false;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let activeOcrRuns = 0;
let releasePromise: Promise<void> | null = null;

ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException("ocrCancelled", "AbortError");
};

const nextFrame = yieldOcr;

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

async function loadModels(revision: string, recognition: boolean, signal?: AbortSignal): Promise<LoadedModels> {
  const root = `https://raw.githubusercontent.com/ndl-lab/ndlkotenocr-lite/${revision}`;
  const webGpuAvailable = typeof navigator !== "undefined" && Boolean(navigator.gpu?.requestAdapter);
  requestOcrModelStoragePersistence();

  const createBoth = async (useWebGpu: boolean) => {
    let detector: ort.InferenceSession | undefined;
    let recognizer: ort.InferenceSession | undefined;
    try {
      const charsetBytes = recognition
        ? await loadCachedAsset(`${root}/src/config/NDLmoji.yaml`, signal, (status) => new LocalizedError("errorCharsetHttp", { status }))
        : null;
      // ORT WebGPU session initialization must remain sequential.
      detector = await createSession(`${root}/src/model/rtmdet-s-1280x1280.onnx`, useWebGpu, signal);
      if (recognition) recognizer = await createSession(`${root}/src/model/parseq-ndl-32x384-tiny-10.onnx`, useWebGpu, signal);
      throwIfAborted(signal);
      let charset: string[] = [];
      if (charsetBytes) {
        const match = new TextDecoder().decode(charsetBytes).match(/charset_train:\s*("(?:\\.|[^"\\])*")/);
        if (!match) throw new LocalizedError("errorCharsetFormat");
        charset = Array.from(JSON.parse(match[1]) as string);
      }

      return {
        revision,
        detector,
        recognizer,
        charset,
        provider: useWebGpu ? "WebGPU" as const : "WASM" as const,
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
  const key = `ndl-ocr:${url}`;
  const cached = await readOcrModelAsset(key);
  throwIfAborted(signal);
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

async function getModels(revision: string, recognition: boolean, signal?: AbortSignal): Promise<LoadedModels> {
  if (!modelPromise) {
    loadedRevision = revision;
    loadedRecognition = recognition;
    modelPromise = loadModels(revision, recognition, signal).catch((error) => {
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
  if (releaseTimer === null) return;
  clearTimeout(releaseTimer);
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
        models.recognizer?.release() ?? Promise.resolve(),
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
  clearNdlOcrModelReleaseTimer();
  releaseTimer = setTimeout(() => {
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
      response = await fetchOcrResource(url, { mode: "cors", cache: "force-cache" }, signal);
    } catch (error) {
      if (signal?.aborted) throw new DOMException("ocrCancelled", "AbortError");
      throw error instanceof OcrFailure ? error : new OcrFailure(`Image request failed: ${String(error)}`, "image");
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

const bitmapSourceSizes = new WeakMap<ImageBitmap, { width: number; height: number }>();
async function loadImage(url: string, signal?: AbortSignal, maxSize = 2048): Promise<ImageBitmap> {
  try {
    const blob = await fetchImageBlob(url, signal);
    throwIfAborted(signal);
    let bitmap = await createImageBitmap(blob);
    const originalSize = { width: bitmap.width, height: bitmap.height };
    if (Math.max(bitmap.width, bitmap.height) > maxSize) {
      const ratio = maxSize / Math.max(bitmap.width, bitmap.height);
      const original = bitmap;
      try { bitmap = await createImageBitmap(original, { resizeWidth: Math.max(1, Math.floor(original.width * ratio)), resizeHeight: Math.max(1, Math.floor(original.height * ratio)), resizeQuality: "high" }); }
      finally { original.close(); }
    }
    if (signal?.aborted) {
      bitmap.close();
      throw new DOMException("ocrCancelled", "AbortError");
    }
    bitmapSourceSizes.set(bitmap, originalSize);
    return bitmap;
  } catch (error) {
    if (signal?.aborted) throw new DOMException("ocrCancelled", "AbortError");
    throw error instanceof OcrFailure ? error : new OcrFailure(`Image decode failed: ${String(error)}`, "image");
  }
}

function imageBitmapCanvas(bitmap: ImageBitmap): OcrCanvas {
  const canvas = createOcrCanvas();
  try {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new LocalizedError("errorCanvasInit");
    context.drawImage(bitmap, 0, 0);
    return canvas;
  } catch (error) {
    releaseOcrCanvas(canvas);
    throw error;
  }
}

function detectorInput(source: OcrCanvas): { tensor: ort.Tensor; paddedSize: number } {
  const paddedSize = Math.max(source.width, source.height);
  const square = createOcrCanvas();
  square.width = paddedSize;
  square.height = paddedSize;
  const resized = createOcrCanvas();
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
    releaseOcrCanvas(square);
    releaseOcrCanvas(resized);
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
  source: OcrCanvas,
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
  source: OcrCanvas,
  region: OcrRegion,
  orientation: RecognitionOrientation = "auto",
  deskewAngle = 0,
): ort.Tensor {
  const bounds = floorCeilCropRegion(region, { width: source.width, height: source.height });
  const cropWidth = Math.max(1, bounds.width);
  const cropHeight = Math.max(1, bounds.height);
  const crop = createOcrCanvas();
  crop.width = cropWidth;
  crop.height = cropHeight;
  let line: OcrCanvas | null = null;
  const resized = createOcrCanvas();
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
    releaseOcrCanvas(crop);
    releasePreprocessedCanvas(line);
    releaseOcrCanvas(resized);
  }
}

function lineCanvas(source: OcrCanvas, region: OcrRegion): OcrCanvas {
  const bounds = floorCeilCropRegion(region, { width: source.width, height: source.height });
  const canvas = createOcrCanvas();
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
    releaseOcrCanvas(canvas);
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
  source: OcrCanvas,
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

function splitDetectionAtInkGap(source: OcrCanvas, detection: Detection): Detection[] {
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

function splitDetectionsAtInkGaps(source: OcrCanvas, detections: Detection[]): Detection[] {
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
    ? `${page.imageServiceId.replace(/\/$/, "")}/full/!2000,2000/0/default.jpg`
    : page.image;
}

async function recognizeCanvasLine(
  source: OcrCanvas,
  region: OcrRegion,
  models: LoadedModels,
  orientation: RecognitionOrientation = "auto",
  deskewAngle = 0,
  signal?: AbortSignal,
): Promise<DecodedRecognition> {
  throwIfAborted(signal);
  const recognizer = models.recognizer;
  if (!recognizer) throw new OcrFailure("PARSeq recognition model is not loaded", "model");
  const input = recognizerInput(source, region, orientation, deskewAngle);
  let outputs: ort.InferenceSession.OnnxValueMapType | null = null;
  try {
    outputs = await recognizer.run({ [recognizer.inputNames[0]]: input });
    throwIfAborted(signal);
    return decodeText(outputs, models.charset);
  } finally {
    input.dispose();
    disposeTensors(outputs);
  }
}

export function recognizePageWithNdlLite(
  page: ViewerPage,
  options: NdlOcrOptions = DEFAULT_NDL_OCR_OPTIONS,
  onProgress: ProgressCallback = () => undefined,
  signal?: AbortSignal,
): Promise<NdlOcrResult> {
  return runNdlPage("recognize", { page, options, onProgress, signal });
}

export function detectPageLines(
  page: ViewerPage,
  options: NdlOcrOptions = DEFAULT_NDL_OCR_OPTIONS,
  onProgress: ProgressCallback = () => undefined,
  signal?: AbortSignal,
): Promise<DetectedPage> {
  return runNdlPage("detect", { page, options, onProgress, signal });
}

type NdlPageInput = { page: ViewerPage; options: NdlOcrOptions; onProgress: ProgressCallback; signal?: AbortSignal };
function runNdlPage(mode: "detect", input: NdlPageInput): Promise<DetectedPage>;
function runNdlPage(mode: "recognize", input: NdlPageInput): Promise<NdlOcrResult>;
async function runNdlPage(mode: "detect" | "recognize", { page, options, onProgress, signal }: NdlPageInput): Promise<DetectedPage | NdlOcrResult> {
  if (page.ocrAvailability === "unsupported") throw new OcrFailure(page.unsupportedReason ?? "Unsupported Canvas", "unsupported");
  const normalizedOptions = normalizeNdlOcrOptions(options);
  const startedAt = Date.now();
  const stats: OcrRunStats = {
    detectionCount: 0, modelInferenceCount: 0, adaptiveTiles: 0, initialRecognitions: 0,
    extraRecognitions: 0, extraRecognitionAttempts: 0, highResolutionRetries: 0,
    additionalCropRequests: 0, additionalCropFailures: 0, maxCanvasPixels: 0, durationMs: 0,
    imageRequests: 0, sourceTiles: 0, warnings: [],
  };
  clearNdlOcrModelReleaseTimer();
  if (releasePromise) await releasePromise;
  if (activeOcrRuns > 0) throw new OcrFailure("Another OCR operation is still running", "worker");
  const revision = ndlModelRevision(normalizedOptions.modelRevision);
  if (modelPromise && (loadedRevision !== revision || mode === "recognize" && !loadedRecognition)) await releaseNdlOcrModels();
  if (activeOcrRuns > 0) throw new OcrFailure("Another OCR operation is still running", "worker");
  activeOcrRuns++;
  resetCanvasCounters();
  let currentCanvas: OcrCanvas | null = null;
  let currentSegment = -1;
  const recordCanvas = (canvas: OcrCanvas) => { stats.maxCanvasPixels = Math.max(stats.maxCanvasPixels, canvas.width * canvas.height); };
  try {
    throwIfAborted(signal);
    onProgress({ stage: "image", percent: 2, messageKey: "progressImage" });
    const source = await resolvePageImageSource(page, normalizedOptions, signal);
    stats.warnings = source.warnings;
    stats.sourceTiles = source.segments.length;
    const getSegment = async (index: number): Promise<OcrCanvas> => {
      if (currentSegment === index && currentCanvas) return currentCanvas;
      releasePreprocessedCanvas(currentCanvas); currentCanvas = null; currentSegment = -1;
      throwIfAborted(signal);
      stats.imageRequests!++;
      const bitmap = await loadImage(source.segments[index].url, signal, normalizedOptions.tileMaxSize);
      try {
        currentCanvas = imageBitmapCanvas(bitmap);
        currentSegment = index;
        recordCanvas(currentCanvas);
        if (!source.info) {
          const original = bitmapSourceSizes.get(bitmap)!;
          source.width = original.width; source.height = original.height;
          source.segments[index].region = { x: 0, y: 0, width: original.width, height: original.height };
        }
        return currentCanvas;
      } finally { bitmap.close(); }
    };
    onProgress({ stage: "models", percent: 5, messageKey: "progressModels" });
    let models: LoadedModels;
    try { models = await getModels(revision, mode === "recognize", signal); }
    catch (error) {
      throwIfAborted(signal);
      throw new OcrFailure(`OCR model initialization failed: ${String(error)}`, "model");
    }
    const threshold = detectionThresholdForProfile(normalizedOptions.profile);
    const detected: Array<Detection & { sourceTile: number }> = [];
    for (let index = 0; index < source.segments.length; index++) {
      throwIfAborted(signal);
      const canvas = await getSegment(index);
      onProgress({ stage: "detect", percent: 10 + Math.round(index / source.segments.length * 20), messageKey: "progressDetect" });
      let local = await detectOnCanvas(canvas, models, threshold, signal, () => { stats.modelInferenceCount++; });
      if (normalizedOptions.enableAdaptiveTiling) {
        const tiles = createAdaptiveTiles(canvas, normalizedOptions.profile, estimateUncoveredInkRegions(canvas, local));
        for (const tile of tiles) {
          throwIfAborted(signal);
          const crop = lineCanvas(canvas, tile);
          try {
            const extra = await detectOnCanvas(crop, models, threshold, signal, () => { stats.modelInferenceCount++; });
            local.push(...extra.map((detection) => ({ ...restoreTileRegion(tile, detection, canvas), detectionScore: detection.detectionScore })));
            stats.adaptiveTiles++;
          } finally { releasePreprocessedCanvas(crop); }
        }
      }
      local = splitDetectionsAtInkGaps(canvas, mergeAdjacentDetections(globalNms(local), {
        orientation: normalizedOptions.writingMode, maxGapRatio: 1.2, transverseOverlapThreshold: 0.65,
      }));
      detected.push(...local.map((detection) => ({ ...toSourceRegion(detection, source.segments[index].region, canvas), sourceTile: index, detectionScore: detection.detectionScore })));
      await nextFrame();
    }
    const detections = mergeSourceDetections(detected, normalizedOptions.writingMode);
    // Reuse one tile at a time; reading order is assigned after recognition.
    const containingTile = (box: Detection) => source.segments.findIndex(({ region }) => box.x >= region.x && box.y >= region.y && box.x + box.width <= region.x + region.width && box.y + box.height <= region.y + region.height);
    detections.sort((a, b) => containingTile(a) - containingTile(b));
    stats.detectionCount = detections.length;
    if (mode === "detect") {
      stats.durationMs = Date.now() - startedAt;
      onProgress({ stage: "done", percent: 100, messageKey: "progressDone", params: { count: detections.length }, completed: detections.length, total: detections.length });
      return { imageWidth: source.width, imageHeight: source.height, detections, detectorRevision: models.revision,
        provider: models.provider, options: normalizedOptions, stats };
    }
    const candidates: RecognitionCandidate[][] = [];
    const retryTargets: RetryTarget[] = [];
    const contains = (outer: OcrRegion, inner: OcrRegion) => inner.x >= outer.x - 0.01 && inner.y >= outer.y - 0.01
      && inner.x + inner.width <= outer.x + outer.width + 0.01 && inner.y + inner.height <= outer.y + outer.height + 0.01;
    const cropInputs = new WeakMap<OcrCanvas, RecognitionCandidate["input"]>();
    const getCrop = async (detection: Detection, padded: boolean, highResolution = false): Promise<OcrCanvas> => {
      const bounds = padded ? expandCropRegion(detection, DEFAULT_CROP_PADDING, source, detections) : detection;
      const index = source.segments.findIndex((segment) => contains(segment.region, bounds));
      const url = sourceRegionUrl(source, bounds, 1024);
      if ((highResolution || index < 0) && url) {
        stats.additionalCropRequests++; stats.imageRequests!++;
        const bitmap = await loadImage(url, signal, 1024);
        try { const crop = imageBitmapCanvas(bitmap); recordCanvas(crop); cropInputs.set(crop, { imageUrl: url, sourceRegion: bounds, width: crop.width, height: crop.height }); return crop; }
        finally { bitmap.close(); }
      }
      if (index < 0) throw new OcrFailure("A line crosses unavailable source image regions", "image");
      const canvas = await getSegment(index);
      const crop = lineCanvas(canvas, toSegmentRegion(bounds, source.segments[index].region, canvas));
      recordCanvas(crop);
      cropInputs.set(crop, { imageUrl: source.segments[index].url, sourceRegion: bounds, width: crop.width, height: crop.height });
      return crop;
    };
    const recognize = (crop: OcrCanvas, orientation: RecognitionOrientation = "auto", angle = 0) => {
      stats.modelInferenceCount++;
      return recognizeCanvasLine(crop, { x: 0, y: 0, width: crop.width, height: crop.height }, models, orientation, angle, signal);
    };
    // First complete every original line, so the retry budget is not consumed by the first detection.
    for (let index = 0; index < detections.length; index++) {
      throwIfAborted(signal);
      const detection = detections[index];
      const crop = await getCrop(detection, false);
      try {
        const original = await recognize(crop);
        stats.initialRecognitions++;
        candidates.push([recognitionCandidateFromDecoded(original, { source: "page", preprocessing: "original", orientation: "auto", order: 0, input: cropInputs.get(crop) })]);
        retryTargets.push({ index, score: original.recognitionScore,
          lowConfidence: isRecognitionLowConfidence(original, detection, normalizedOptions.profile),
          shortSide: Math.min(crop.width, crop.height), aspectRatio: Math.max(crop.width, crop.height) / Math.max(1, Math.min(crop.width, crop.height)),
          quality: measureImageQuality(crop),
        });
      } finally { releasePreprocessedCanvas(crop); }
      onProgress({ stage: "recognize", percent: 30 + Math.round((index + 1) / Math.max(1, detections.length) * 45),
        messageKey: "progressRecognize", params: { completed: index + 1, total: detections.length }, completed: index + 1, total: detections.length });
      await nextFrame();
    }
    const retries = scheduleRetries(retryTargets, normalizedOptions, Boolean(source.info?.region && source.info.resize));
    for (const retry of retries) {
      throwIfAborted(signal);
      if (stats.extraRecognitionAttempts >= normalizedOptions.maxExtraRecognitions) break;
      const detection = detections[retry.index];
      let crop: OcrCanvas | null = null, processed: OcrCanvas | null = null;
      try {
        // Segmentation consumes one inference per window, never more than the page budget.
        if (retry.kind === "segmented") {
          const remaining = normalizedOptions.maxExtraRecognitions - stats.extraRecognitionAttempts;
          const windows = createLineWindows(detection, source, { maxWindows: Math.min(4, remaining) });
          if (windows.length < 2 || windows.length > remaining) continue;
          const parts: DecodedRecognition[] = [];
          for (const window of windows) {
            stats.extraRecognitionAttempts++;
            crop = await getCrop({ ...window, detectionScore: detection.detectionScore }, false);
            try { parts.push(await recognize(crop)); stats.extraRecognitions++; }
            finally { releasePreprocessedCanvas(crop); crop = null; }
          }
          const combined = combineSegmentRecognitions(parts);
          if (combined) candidates[retry.index].push({ ...combined, source: "segmented", preprocessing: "original", order: candidates[retry.index].length });
          continue;
        }
        stats.extraRecognitionAttempts++;
        const correction = ["background-normalized", "grayscale-contrast", "sauvola", "adaptive-binary"].includes(retry.kind);
        crop = await getCrop(detection, !correction && retry.kind !== "direction", retry.kind === "high-resolution");
        if (correction) processed = preprocessCanvas(crop, retry.kind as "sauvola");
        const orientation: RecognitionOrientation = retry.kind === "direction" ? (crop.height > crop.width ? "normal" : "rotate-90") : "auto";
        const angle = retry.kind === "deskew" ? rankDeskewAngles(crop)[0] ?? 0 : 0;
        const decoded = await recognize(processed ?? crop, orientation, angle);
        stats.extraRecognitions++;
        if (retry.kind === "high-resolution") stats.highResolutionRetries++;
        candidates[retry.index].push(recognitionCandidateFromDecoded(decoded, {
          source: retry.kind === "high-resolution" ? "iiif-crop" : "page",
          preprocessing: correction ? retry.kind as "sauvola" : retry.kind === "high-resolution" ? "high-resolution-padded" : retry.kind === "padded" ? "padded" : "original",
          input: { ...cropInputs.get(crop)!, parameters: retry.kind === "sauvola" ? { radius: 12, k: 0.2, R: 128 }
            : retry.kind === "grayscale-contrast" ? { lowPercentile: 0.02, highPercentile: 0.98, strength: 0.5 }
            : retry.kind === "background-normalized" ? { radius: Math.max(8, Math.round(Math.min(crop.width, crop.height) * 0.75)), denominatorFloor: 32 }
            : retry.kind === "adaptive-binary" ? { radius: Math.max(2, Math.round(Math.min(crop.width, crop.height) * 0.035)), meanFactor: 0.9 }
            : { longitudinalPadding: retry.kind === "direction" ? 0 : DEFAULT_CROP_PADDING.longitudinalRatio, transversePadding: retry.kind === "direction" ? 0 : DEFAULT_CROP_PADDING.transverseRatio } },
          orientation, deskewAngle: angle, order: candidates[retry.index].length,
        }));
      } catch (error) {
        throwIfAborted(signal);
        // Session failures are fatal; failed optional image requests retain the original.
        if (!(error instanceof OcrFailure) || error.kind !== "image") throw error;
        stats.additionalCropFailures++;
        stats.warnings!.push(`Optional crop failed for line ${retry.index + 1}: ${error.message}`);
      } finally { releasePreprocessedCanvas(processed); releasePreprocessedCanvas(crop); }
      onProgress({ stage: "retry", percent: 76 + Math.round(stats.extraRecognitionAttempts / Math.max(1, normalizedOptions.maxExtraRecognitions) * 20),
        messageKey: "progressRetry", params: { completed: stats.extraRecognitionAttempts, total: normalizedOptions.maxExtraRecognitions },
        completed: stats.extraRecognitionAttempts, total: normalizedOptions.maxExtraRecognitions });
      await nextFrame();
    }
    const lines = candidates.map((items, index): OcrLine => {
      const selection = selectRecognitionCandidate(items);
      // An explicit benchmark candidate is exposed for comparison, never auto-adopted.
      const selected = normalizedOptions.benchmarkPreprocessing ? items[0] : selection.selected;
      const { order: _order, ...value } = selected;
      return { ...value, id: `line-${index}`, detectionIndex: index, detectionScore: detections[index].detectionScore,
        region: { x: detections[index].x, y: detections[index].y, width: detections[index].width, height: detections[index].height },
        alternatives: items.filter((item) => item !== selected).map(({ order: _order, ...item }) => item),
        uncertain: selection.uncertain || retryTargets[index].lowConfidence,
        selectionReason: normalizedOptions.benchmarkPreprocessing ? "evaluation-only" : selection.reason,
      };
    });
    const orderedLines = orderOcrLines(lines, { writingMode: normalizedOptions.writingMode, scattered: normalizedOptions.scattered });
    stats.durationMs = Date.now() - startedAt;
    onProgress({ stage: "done", percent: 100, messageKey: "progressDone", params: { count: lines.length }, completed: lines.length, total: lines.length });
    return { imageWidth: source.width, imageHeight: source.height, lines: orderedLines, provider: models.provider,
      revision: models.revision, pipelineVersion: OCR_PIPELINE_VERSION, profile: normalizedOptions.profile, options: normalizedOptions, stats };
  } finally {
    releasePreprocessedCanvas(currentCanvas);
    stats.maxCanvasPixels = Math.max(stats.maxCanvasPixels, canvasCounters().maxPixels);
    stats.maxLiveCanvases = canvasCounters().peak;
    stats.liveCanvasesAfterPage = canvasCounters().live;
    activeOcrRuns--;
    if (activeOcrRuns === 0) scheduleNdlOcrModelRelease();
  }
}
