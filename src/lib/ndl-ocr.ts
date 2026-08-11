import * as ort from "onnxruntime-web/webgpu";
import type { OcrLine, OcrRegion, ViewerPage } from "./iiif";
import { LocalizedError, type MessageParams } from "./i18n";

const MODEL_REVISION = "ede4283845cdc0ba2bda8b7ebfc3dc80b33c92c8";
const MODEL_ROOT = `https://raw.githubusercontent.com/ndl-lab/ndlkotenocr-lite/${MODEL_REVISION}`;
const DETECTOR_URL = `${MODEL_ROOT}/src/model/rtmdet-s-1280x1280.onnx`;
const RECOGNIZER_URL = `${MODEL_ROOT}/src/model/parseq-ndl-32x384-tiny-10.onnx`;
const CHARSET_URL = `${MODEL_ROOT}/src/config/NDLmoji.yaml`;
// The official filename says 1280x1280, but the pinned ONNX graph metadata
// requires [1, 3, 1024, 1024]. The graph shape is authoritative.
const DETECTOR_SIZE = 1024;
const RECOGNIZER_WIDTH = 384;
const RECOGNIZER_HEIGHT = 32;
const DETECTION_THRESHOLD = 0.3;

export type NdlOcrStage = "image" | "models" | "detect" | "recognize" | "done";
export type NdlOcrProgressKey = "progressStarting" | "progressImage" | "progressModels" | "progressDetect" | "progressRecognize" | "progressDone";

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
};

type ProgressCallback = (progress: NdlOcrProgress) => void;
type LoadedModels = {
  detector: ort.InferenceSession;
  recognizer: ort.InferenceSession;
  charset: string[];
  provider: NdlOcrResult["provider"];
};

type Detection = OcrRegion & { confidence: number };

let modelPromise: Promise<LoadedModels> | null = null;

ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException("ocrCancelled", "AbortError");
};

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function createSession(url: string, useWebGpu: boolean): Promise<ort.InferenceSession> {
  const executionProviders = useWebGpu ? ["webgpu", "wasm"] : ["wasm"];
  return ort.InferenceSession.create(url, {
    executionProviders,
    graphOptimizationLevel: "all",
  });
}

async function loadModels(): Promise<LoadedModels> {
  const webGpuAvailable = typeof navigator !== "undefined" && "gpu" in navigator;

  const createBoth = async (useWebGpu: boolean) => {
    const [detector, recognizer, charsetResponse] = await Promise.all([
      createSession(DETECTOR_URL, useWebGpu),
      createSession(RECOGNIZER_URL, useWebGpu),
      fetch(CHARSET_URL),
    ]);

    if (!charsetResponse.ok) {
      throw new LocalizedError("errorCharsetHttp", { status: charsetResponse.status });
    }

    const yaml = await charsetResponse.text();
    const match = yaml.match(/charset_train:\s*("(?:\\.|[^"\\])*")/);
    if (!match) throw new LocalizedError("errorCharsetFormat");
    const charset = Array.from(JSON.parse(match[1]) as string);

    return {
      detector,
      recognizer,
      charset,
      provider: useWebGpu ? "WebGPU / WASM" as const : "WASM" as const,
    };
  };

  if (webGpuAvailable) {
    try {
      return await createBoth(true);
    } catch (error) {
      console.warn("NDL OCR WebGPU initialization failed; falling back to WASM.", error);
    }
  }

  return createBoth(false);
}

async function getModels(): Promise<LoadedModels> {
  if (!modelPromise) {
    modelPromise = loadModels().catch((error) => {
      modelPromise = null;
      throw error;
    });
  }
  return modelPromise;
}

async function loadImage(url: string, signal?: AbortSignal): Promise<ImageBitmap> {
  let response: Response;
  try {
    response = await fetch(url, { signal, mode: "cors", cache: "force-cache" });
  } catch (error) {
    if (signal?.aborted) throw new DOMException("ocrCancelled", "AbortError");
    throw new LocalizedError("errorImageFetch", { detail: error instanceof Error ? ` (${error.message})` : "" });
  }
  if (!response.ok) throw new LocalizedError("errorImageHttp", { status: response.status });
  return createImageBitmap(await response.blob());
}

function imageBitmapCanvas(bitmap: ImageBitmap): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new LocalizedError("errorCanvasInit");
  context.drawImage(bitmap, 0, 0);
  return canvas;
}

function detectorInput(source: HTMLCanvasElement): { tensor: ort.Tensor; paddedSize: number } {
  const paddedSize = Math.max(source.width, source.height);
  const square = document.createElement("canvas");
  square.width = paddedSize;
  square.height = paddedSize;
  const squareContext = square.getContext("2d");
  if (!squareContext) throw new LocalizedError("errorDetectionCanvas");
  squareContext.fillStyle = "#000";
  squareContext.fillRect(0, 0, paddedSize, paddedSize);
  squareContext.drawImage(source, 0, 0);

  const resized = document.createElement("canvas");
  resized.width = DETECTOR_SIZE;
  resized.height = DETECTOR_SIZE;
  const context = resized.getContext("2d", { willReadFrequently: true });
  if (!context) throw new LocalizedError("errorDetectionCanvas");
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
}

function median(values: number[]): number {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

function detectDocumentRegion(source: HTMLCanvasElement): OcrRegion | null {
  const scale = Math.min(1, 256 / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;

  const borderReds: number[] = [];
  const borderGreens: number[] = [];
  const borderBlues: number[] = [];
  const borderWidth = Math.max(1, Math.round(Math.min(width, height) * 0.025));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x >= borderWidth && x < width - borderWidth && y >= borderWidth && y < height - borderWidth) continue;
      const offset = (y * width + x) * 4;
      borderReds.push(pixels[offset]);
      borderGreens.push(pixels[offset + 1]);
      borderBlues.push(pixels[offset + 2]);
    }
  }
  const background = [median(borderReds), median(borderGreens), median(borderBlues)];
  const foreground = new Uint8Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    const red = pixels[offset] - background[0];
    const green = pixels[offset + 1] - background[1];
    const blue = pixels[offset + 2] - background[2];
    foreground[index] = Math.sqrt((red * red) + (green * green) + (blue * blue)) >= 24 ? 1 : 0;
  }

  const visited = new Uint8Array(width * height);
  let best: { area: number; minX: number; minY: number; maxX: number; maxY: number } | null = null;
  const queue = new Int32Array(width * height);
  for (let start = 0; start < foreground.length; start += 1) {
    if (!foreground[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      area += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      const neighbors = [index - 1, index + 1, index - width, index + width];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || neighbor >= foreground.length || visited[neighbor] || !foreground[neighbor]) continue;
        const neighborX = neighbor % width;
        if (Math.abs(neighborX - x) > 1) continue;
        visited[neighbor] = 1;
        queue[tail++] = neighbor;
      }
    }

    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    const fillRatio = area / (componentWidth * componentHeight);
    if (
      area >= width * height * 0.03
      && componentWidth >= width * 0.18
      && componentHeight >= height * 0.18
      && fillRatio >= 0.22
      && (!best || area > best.area)
    ) {
      best = { area, minX, minY, maxX, maxY };
    }
  }

  if (!best) return null;
  const padding = Math.max(2, Math.round(Math.min(width, height) * 0.015));
  const x1 = Math.max(0, best.minX - padding);
  const y1 = Math.max(0, best.minY - padding);
  const x2 = Math.min(width, best.maxX + padding + 1);
  const y2 = Math.min(height, best.maxY + padding + 1);
  if ((x2 - x1) >= width * 0.96 && (y2 - y1) >= height * 0.96) return null;
  return {
    x: x1 / scale,
    y: y1 / scale,
    width: (x2 - x1) / scale,
    height: (y2 - y1) / scale,
  };
}

function decodeDetections(
  outputs: ort.InferenceSession.OnnxValueMapType,
  paddedSize: number,
  imageWidth: number,
  imageHeight: number,
  documentRegion: OcrRegion | null,
): Detection[] {
  const tensors = Object.values(outputs).filter((value): value is ort.Tensor => value instanceof ort.Tensor);
  const boxes = tensors.find((tensor) => tensor.dims.at(-1) === 5);
  if (!boxes) throw new LocalizedError("errorDetectionOutput");

  const values = boxes.data as Float32Array;
  const scale = paddedSize / DETECTOR_SIZE;
  const detections: Detection[] = [];

  for (let offset = 0; offset + 4 < values.length; offset += 5) {
    const score = values[offset + 4];
    if (!Number.isFinite(score) || score <= DETECTION_THRESHOLD) continue;

    const rawX1 = values[offset] * scale;
    const rawY1 = values[offset + 1] * scale;
    const rawX2 = values[offset + 2] * scale;
    const rawY2 = values[offset + 3] * scale;
    const rawWidth = rawX2 - rawX1;
    const rawHeight = rawY2 - rawY1;
    const centerX = rawX1 + (rawWidth / 2);
    const centerY = rawY1 + (rawHeight / 2);
    if (rawWidth <= 0 || rawHeight <= 0 || centerX >= imageWidth || centerY >= imageHeight) continue;
    if (documentRegion && (
      centerX < documentRegion.x
      || centerX > documentRegion.x + documentRegion.width
      || centerY < documentRegion.y
      || centerY > documentRegion.y + documentRegion.height
    )) continue;
    const yPadding = Math.max(1, (rawY2 - rawY1) * 0.02);
    const x1 = Math.max(0, Math.min(imageWidth, rawX1));
    const y1 = Math.max(0, Math.min(imageHeight, rawY1 - yPadding));
    const x2 = Math.max(0, Math.min(imageWidth, rawX2));
    const y2 = Math.max(0, Math.min(imageHeight, rawY2 + yPadding));
    const width = x2 - x1;
    const height = y2 - y1;
    const retainedAreaRatio = (width * height) / (rawWidth * (rawHeight + (yPadding * 2)));

    if (width < 4 || height < 4 || retainedAreaRatio < 0.65) continue;
    detections.push({ x: x1, y: y1, width, height, confidence: Math.round(score * 100) });
  }

  const verticalCount = detections.filter((item) => item.height > item.width).length;
  const vertical = detections.length < verticalCount * 2;
  const spans = detections.map((item) => vertical ? item.width : item.height);
  const margin = median(spans) * 0.3;
  const ordered = detections.sort((a, b) => {
    const aX = a.x + (a.width / 2);
    const bX = b.x + (b.width / 2);
    const aY = a.y + (a.height / 2);
    const bY = b.y + (b.height / 2);

    if (vertical) {
      if (margin < bX - aX) return 1;
      if (margin < aX - bX) return -1;
      return aY - bY;
    }
    if (margin < aY - bY) return 1;
    if (margin < bY - aY) return -1;
    return aX - bX;
  });

  const unique: Detection[] = [];
  for (const detection of ordered) {
    const previous = unique.at(-1);
    if (!previous) {
      unique.push(detection);
      continue;
    }

    const intersectionWidth = Math.max(
      0,
      Math.min(previous.x + previous.width, detection.x + detection.width) - Math.max(previous.x, detection.x),
    );
    const intersectionHeight = Math.max(
      0,
      Math.min(previous.y + previous.height, detection.y + detection.height) - Math.max(previous.y, detection.y),
    );
    const intersection = intersectionWidth * intersectionHeight;
    const overlap = intersection / Math.min(previous.width * previous.height, detection.width * detection.height);

    if (overlap > 0.9) {
      if (detection.confidence >= previous.confidence) unique[unique.length - 1] = detection;
      continue;
    }
    unique.push(detection);
  }

  return unique;
}

function recognizerInput(source: HTMLCanvasElement, region: OcrRegion): ort.Tensor {
  const cropWidth = Math.max(1, Math.round(region.width));
  const cropHeight = Math.max(1, Math.round(region.height));
  const crop = document.createElement("canvas");
  crop.width = cropWidth;
  crop.height = cropHeight;
  const cropContext = crop.getContext("2d");
  if (!cropContext) throw new LocalizedError("errorRecognitionCanvas");
  cropContext.drawImage(
    source,
    Math.round(region.x),
    Math.round(region.y),
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight,
  );

  let line = crop;
  if (cropHeight > cropWidth) {
    const rotated = document.createElement("canvas");
    rotated.width = cropHeight;
    rotated.height = cropWidth;
    const rotatedContext = rotated.getContext("2d");
    if (!rotatedContext) throw new LocalizedError("errorVerticalCanvas");
    rotatedContext.translate(0, cropWidth);
    rotatedContext.rotate(-Math.PI / 2);
    rotatedContext.drawImage(crop, 0, 0);
    line = rotated;
  }

  const resized = document.createElement("canvas");
  resized.width = RECOGNIZER_WIDTH;
  resized.height = RECOGNIZER_HEIGHT;
  const context = resized.getContext("2d", { willReadFrequently: true });
  if (!context) throw new LocalizedError("errorRecognitionCanvas");
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
}

function decodeText(outputs: ort.InferenceSession.OnnxValueMapType, charset: string[]): string {
  const tensor = Object.values(outputs).find((value): value is ort.Tensor => value instanceof ort.Tensor);
  if (!tensor || tensor.dims.length < 2) throw new LocalizedError("errorRecognitionOutput");

  const values = tensor.data as Float32Array;
  const classCount = tensor.dims.at(-1) ?? 0;
  const sequenceLength = tensor.dims.at(-2) ?? 0;
  let text = "";

  for (let position = 0; position < sequenceLength; position += 1) {
    const start = position * classCount;
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < classCount; index += 1) {
      const value = values[start + index];
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    }
    if (bestIndex === 0) break;
    text += charset[bestIndex - 1] ?? "";
  }
  return text;
}

export function buildNdlOcrImageUrl(page: ViewerPage): string {
  return page.imageServiceId
    ? `${page.imageServiceId.replace(/\/$/, "")}/full/2000,/0/default.jpg`
    : page.image;
}

export async function recognizePageWithNdlLite(
  imageUrl: string,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<NdlOcrResult> {
  throwIfAborted(signal);
  onProgress({ stage: "image", percent: 3, messageKey: "progressImage" });
  const bitmap = await loadImage(imageUrl, signal);
  throwIfAborted(signal);
  const source = imageBitmapCanvas(bitmap);
  bitmap.close();

  onProgress({ stage: "models", percent: 8, messageKey: "progressModels" });
  const models = await getModels();
  throwIfAborted(signal);

  onProgress({ stage: "detect", percent: 22, messageKey: "progressDetect" });
  const { tensor, paddedSize } = detectorInput(source);
  const documentRegion = detectDocumentRegion(source);
  const detectionOutputs = await models.detector.run({ [models.detector.inputNames[0]]: tensor });
  const detections = decodeDetections(detectionOutputs, paddedSize, source.width, source.height, documentRegion);
  throwIfAborted(signal);
  if (!detections.length) throw new LocalizedError("errorNoLines");

  const lines: OcrLine[] = [];
  for (let index = 0; index < detections.length; index += 1) {
    throwIfAborted(signal);
    const detection = detections[index];
    onProgress({
      stage: "recognize",
      percent: 28 + Math.round(((index + 1) / detections.length) * 68),
      messageKey: "progressRecognize",
      params: { completed: index + 1, total: detections.length },
      completed: index + 1,
      total: detections.length,
    });
    const input = recognizerInput(source, detection);
    const outputs = await models.recognizer.run({ [models.recognizer.inputNames[0]]: input });
    lines.push({
      text: decodeText(outputs, models.charset),
      confidence: detection.confidence,
      region: { x: detection.x, y: detection.y, width: detection.width, height: detection.height },
    });
    await nextFrame();
  }

  onProgress({
    stage: "done",
    percent: 100,
    messageKey: "progressDone",
    params: { count: lines.length },
    completed: lines.length,
    total: lines.length,
  });
  return {
    imageWidth: source.width,
    imageHeight: source.height,
    lines,
    provider: models.provider,
    revision: MODEL_REVISION,
  };
}
