import type { ViewerPage } from "../../iiif.ts";
import { LocalizedError, type TranslationKey } from "../../i18n.ts";
import { detectPageLines, type DetectedPage } from "../../ndl-ocr.ts";
import { orderOcrLines } from "../reading-order.ts";
import { OCR_PIPELINE_VERSION } from "../benchmark.ts";
import { mapDetectionToHonkokuCrop, buildHonkokuRecognitionImageUrl, cropImageDataWithWhitePadding } from "../crop/honkoku-crop.ts";
import { rawKojiToPlainText } from "../koji/plain-text.ts";
import { assertHonkokuV18Configured, HONKOKU_V18_MANIFEST_URL } from "../engine/feature.ts";
import type {
  LineRecognizer,
  RecognizerContext,
  RecognizerInput,
  RecognizerOutput,
  PageOcrResult,
  PageProgressCallback,
} from "../engine/types.ts";
import { fetchHonkokuModelManifest, HONKOKU_V18_UPSTREAM_COMMIT } from "../models/manifest.ts";
import { cacheHonkokuManifest } from "../models/model-cache.ts";
import type { OcrLine } from "../types.ts";
import type { HonkokuWorkerIn, HonkokuWorkerOut } from "./honkoku-v18-protocol.ts";
import { isWebGpuAvailable } from "../models/runtime.ts";

export const HONKOKU_V18_RECOGNIZER_REVISION = `honkoku-v18@${HONKOKU_V18_UPSTREAM_COMMIT}`;

type PendingRequest = {
  resolve: (result: RecognizerOutput) => void;
  reject: (error: unknown) => void;
};

function abortError(): DOMException {
  return new DOMException("ocrCancelled", "AbortError");
}

export class HonkokuV18Recognizer implements LineRecognizer {
  readonly id = "honkoku-v18" as const;
  readonly revision = HONKOKU_V18_RECOGNIZER_REVISION;
  private worker: Worker | null = null;
  private manifestUrl = "";
  private runCounter = 0;
  private pending = new Map<string, PendingRequest>();
  private initialized = false;
  private provider = "WASM";

  constructor(manifestUrl = HONKOKU_V18_MANIFEST_URL) {
    this.manifestUrl = manifestUrl;
  }

  async initialize(context: RecognizerContext): Promise<void> {
    if (this.initialized) return;
    assertHonkokuV18Configured(this.manifestUrl);
    const { manifest, digest } = await fetchHonkokuModelManifest(this.manifestUrl, context.signal);
    if (manifest.upstreamCommit !== HONKOKU_V18_UPSTREAM_COMMIT) {
      throw new Error("Honkoku model manifest is not pinned to the supported v18 upstream commit.");
    }
    await cacheHonkokuManifest(this.manifestUrl, manifest, digest);
    const worker = new Worker(new URL("./honkoku-v18.worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    const runId = this.nextRunId();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        worker.postMessage({ type: "cancel", runId } satisfies HonkokuWorkerIn);
        reject(abortError());
      };
      context.signal?.addEventListener("abort", onAbort, { once: true });
      worker.onmessage = (event: MessageEvent<HonkokuWorkerOut>) => {
        const message = event.data;
        if (message.runId !== runId) return;
        if (message.type === "model-progress") {
          context.onModelProgress?.(message.progress);
        } else if (message.type === "ready") {
          context.signal?.removeEventListener("abort", onAbort);
          this.provider = message.provider;
          this.initialized = true;
          resolve();
        } else if (message.type === "error") {
          context.signal?.removeEventListener("abort", onAbort);
          reject(new Error(message.error));
        }
      };
      worker.onerror = (event) => {
        context.signal?.removeEventListener("abort", onAbort);
        reject(new Error(event.message || "Honkoku v18 worker failed to initialize."));
      };
      const useWebGpu = !this.isMobile() && typeof navigator !== "undefined" && "gpu" in navigator;
      worker.postMessage({
        type: "initialize",
        runId,
        manifestUrl: this.manifestUrl,
        manifest,
        useWebGpu,
      } satisfies HonkokuWorkerIn);
    }).catch(async (error) => {
      await this.dispose();
      throw error;
    });
  }

  async recognize(input: RecognizerInput, context: RecognizerContext = {}): Promise<RecognizerOutput> {
    if (!this.worker || !this.initialized) throw new Error("Honkoku v18 recognizer is not initialized.");
    if (context.signal?.aborted) throw abortError();
    const runId = this.nextRunId();
    const pending = new Promise<RecognizerOutput>((resolve, reject) => {
      this.pending.set(`${runId}:${input.lineId}`, { resolve, reject });
    });
    const onAbort = () => {
      this.worker?.postMessage({ type: "cancel", runId } satisfies HonkokuWorkerIn);
      this.pending.get(`${runId}:${input.lineId}`)?.reject(abortError());
      this.pending.delete(`${runId}:${input.lineId}`);
    };
    context.signal?.addEventListener("abort", onAbort, { once: true });
    this.worker.postMessage({ type: "recognize", runId, lineId: input.lineId, crop: input.crop } satisfies HonkokuWorkerIn);
    try {
      return await pending;
    } finally {
      context.signal?.removeEventListener("abort", onAbort);
      this.pending.delete(`${runId}:${input.lineId}`);
    }
  }

  async dispose(): Promise<void> {
    for (const request of this.pending.values()) request.reject(abortError());
    this.pending.clear();
    const worker = this.worker;
    this.worker = null;
    this.initialized = false;
    if (!worker) return;
    worker.postMessage({ type: "dispose", runId: this.nextRunId() } satisfies HonkokuWorkerIn);
    worker.terminate();
  }

  get runtimeProvider(): string {
    return this.provider;
  }

  private nextRunId(): string {
    this.runCounter += 1;
    return `honkoku-${Date.now().toString(36)}-${this.runCounter.toString(36)}`;
  }

  private isMobile(): boolean {
    if (typeof navigator === "undefined") return false;
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
      || navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 1024;
  }
}

async function loadCanvas(url: string, signal?: AbortSignal): Promise<HTMLCanvasElement> {
  if (signal?.aborted) throw abortError();
  const response = await fetch(url, { signal, mode: "cors", cache: "force-cache" });
  if (!response.ok) throw new Error(`Honkoku recognition image request failed (HTTP ${response.status}).`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Could not initialize the Honkoku recognition canvas.");
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

function progressForHonkoku(progress: PageProgressCallback, stage: Parameters<PageProgressCallback>[0]["stage"], percent: number, messageKey: TranslationKey, extra: Partial<Parameters<PageProgressCallback>[0]> = {}): void {
  progress({ stage, percent, messageKey, ...extra });
}

export async function recognizePageWithHonkokuV18(
  page: ViewerPage,
  options: import("../profiles.ts").NdlOcrOptions,
  onProgress: PageProgressCallback,
  signal?: AbortSignal,
  manifestUrl = HONKOKU_V18_MANIFEST_URL,
): Promise<PageOcrResult> {
  assertHonkokuV18Configured(manifestUrl);
  const startedAt = Date.now();
  const recognizer = new HonkokuV18Recognizer(manifestUrl);
  let detected: DetectedPage | null = null;
  let recognitionCanvas: HTMLCanvasElement | null = null;
  try {
    progressForHonkoku(onProgress, "image", 2, "progressImage");
    detected = await detectPageLines(page, options, (progress) => {
      const stage = progress.stage === "models" ? "detector-model" : progress.stage;
      progressForHonkoku(onProgress, stage, Math.min(42, progress.percent * 0.42), progress.messageKey, {
        completed: progress.completed,
        total: progress.total,
        params: progress.params,
      });
    }, signal);
    progressForHonkoku(onProgress, "image", 44, "progressImage");
    recognitionCanvas = await loadCanvas(buildHonkokuRecognitionImageUrl(page), signal);
    const recognitionContext = recognitionCanvas.getContext("2d", { willReadFrequently: true });
    if (!recognitionContext) throw new Error("Could not read the Honkoku recognition image.");
    const recognitionImage = recognitionContext.getImageData(0, 0, recognitionCanvas.width, recognitionCanvas.height);
    await recognizer.initialize({
      signal,
      onModelProgress: (modelProgress) => onProgress({
        stage: "recognizer-model",
        percent: 44 + Math.round(modelProgress.percent * 28),
        messageKey: "progressModels",
        params: { file: modelProgress.fileRole ?? "" },
      }),
    });
    const lines: OcrLine[] = [];
    for (let index = 0; index < detected.detections.length; index += 1) {
      if (signal?.aborted) throw abortError();
      const detection = detected.detections[index]!;
      const mapped = mapDetectionToHonkokuCrop(
        detection,
        { width: detected.detectionImageWidth, height: detected.detectionImageHeight },
        { width: recognitionImage.width, height: recognitionImage.height },
      );
      const crop = cropImageDataWithWhitePadding(recognitionImage, mapped.region);
      const result = await recognizer.recognize({ crop, lineId: `line-${index}` }, { signal });
      const rawKoji = result.rawKoji ?? result.text;
      lines.push({
        text: rawKojiToPlainText(rawKoji),
        rawKoji,
        outputFormat: "koji",
        recognizerId: "honkoku-v18",
        recognizerRevision: recognizer.revision,
        confidenceKind: "autoregressive-token",
        confidenceCalibrated: false,
        generatedTokens: result.diagnostics?.generatedTokens,
        stopReason: result.diagnostics?.stopReason,
        meanLogProbability: result.diagnostics?.meanLogProbability,
        minimumTokenProbability: result.diagnostics?.minimumTokenProbability,
        id: `line-${index}`,
        detectionIndex: index,
        detectionScore: detection.detectionScore,
        region: { x: detection.x, y: detection.y, width: detection.width, height: detection.height },
      });
      onProgress({
        stage: "recognize",
        percent: 72 + Math.round(((index + 1) / Math.max(1, detected.detections.length)) * 27),
        messageKey: "progressRecognize",
        completed: index + 1,
        total: detected.detections.length,
      });
    }
    const orderedLines = orderOcrLines(lines, {
      writingMode: options.writingMode,
      scattered: options.scattered,
    });
    const stats = {
      ...detected.stats,
      initialRecognitions: lines.length,
      extraRecognitions: 0,
      extraRecognitionAttempts: 0,
      highResolutionRetries: 0,
      additionalCropRequests: 0,
      additionalCropFailures: 0,
      durationMs: Date.now() - startedAt,
      workerCount: 1,
      provider: recognizer.runtimeProvider,
    };
    progressForHonkoku(onProgress, "done", 100, "progressDone", {
      completed: lines.length,
      total: lines.length,
      params: { count: lines.length },
    });
    const manifest = await fetchHonkokuModelManifest(manifestUrl, signal);
    return {
      imageWidth: detected.detectionImageWidth,
      imageHeight: detected.detectionImageHeight,
      lines: orderedLines,
      engineId: "honkoku-v18",
      engineLabel: "みんなで翻刻 v18",
      provider: recognizer.runtimeProvider,
      detectorRevision: detected.detectorRevision,
      recognizerRevision: recognizer.revision,
      modelManifestDigest: manifest.digest,
      pipelineVersion: OCR_PIPELINE_VERSION,
      profile: options.profile,
      options,
      stats,
      revision: recognizer.revision,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("not configured")) {
      throw new LocalizedError("errorHonkokuUnavailable");
    }
    throw error;
  } finally {
    await recognizer.dispose();
    if (detected?.detectionImage) {
      detected.detectionImage.width = 0;
      detected.detectionImage.height = 0;
    }
    if (recognitionCanvas) {
      recognitionCanvas.width = 0;
      recognitionCanvas.height = 0;
    }
  }
}
