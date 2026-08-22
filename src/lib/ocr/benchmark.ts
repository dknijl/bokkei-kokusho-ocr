import type { ViewerPage } from "../iiif.ts";
import {
  normalizeNdlOcrOptions,
  recognitionRetryThresholdForProfile,
  type NdlOcrOptions,
} from "./profiles.ts";
import { evaluateOcrPage, type OcrGroundTruthPage, type OcrPageMetrics } from "./metrics.ts";
import type { OcrLine, OcrRunStats } from "./types.ts";

export const OCR_BENCHMARK_SCHEMA_VERSION = 2;
export const OCR_PIPELINE_VERSION = "frontend-ocr-accuracy-phase-9-3";

export type OcrBenchmarkRecord = {
  schemaVersion: number;
  pipelineVersion: string;
  createdAt: string;
  modelRevision: string;
  page: {
    manifestUrl: string;
    canvasId: string;
    imageServiceId: string;
    width: number;
    height: number;
  };
  execution: {
    browser: string;
    provider: string;
    profile: NdlOcrOptions["profile"];
    options: NdlOcrOptions;
    stats?: OcrRunStats;
  };
  output: {
    imageWidth: number;
    imageHeight: number;
    fingerprint: string;
    lines: OcrLine[];
  };
  groundTruth?: OcrGroundTruthPage;
  metrics?: OcrPageMetrics;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseOcrGroundTruthJson(value: string): OcrGroundTruthPage {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("Ground truth must be a JSON object.");
  const lines = parsed.lines;
  if (!Array.isArray(lines)) throw new Error("Ground truth lines must be an array.");
  if (typeof parsed.id !== "string" || typeof parsed.manifestUrl !== "string" || typeof parsed.canvasId !== "string") {
    throw new Error("Ground truth requires id, manifestUrl, and canvasId.");
  }
  const parsedLines = lines.map((line) => {
    if (!isRecord(line) || typeof line.text !== "string" || !isRecord(line.region)) {
      throw new Error("Each ground truth line requires text and region.");
    }
    const region = line.region;
    if (
      typeof region.x !== "number"
      || typeof region.y !== "number"
      || typeof region.width !== "number"
      || typeof region.height !== "number"
    ) throw new Error("Ground truth regions require numeric x, y, width, and height.");
    return {
      text: line.text,
      ...(typeof line.normalizedText === "string" ? { normalizedText: line.normalizedText } : {}),
      region: { x: region.x, y: region.y, width: region.width, height: region.height },
    };
  });
  const tags = Array.isArray(parsed.tags) && parsed.tags.every((tag) => typeof tag === "string")
    ? parsed.tags
    : [];
  return {
    id: parsed.id,
    manifestUrl: parsed.manifestUrl,
    canvasId: parsed.canvasId,
    imageServiceId: typeof parsed.imageServiceId === "string" ? parsed.imageServiceId : "",
    width: typeof parsed.width === "number" ? parsed.width : 0,
    height: typeof parsed.height === "number" ? parsed.height : 0,
    lines: parsedLines,
    tags: tags as OcrGroundTruthPage["tags"],
  };
}

function browserName(): string {
  return typeof navigator === "undefined" ? "unknown" : navigator.userAgent;
}

export function ocrLinesFingerprint(lines: OcrLine[]): string {
  return JSON.stringify(lines.map((line) => ({
    id: line.id ?? "",
    text: line.text,
    region: line.region,
    detectionIndex: line.detectionIndex ?? null,
    readingOrder: line.readingOrder ?? null,
    detectionScore: line.detectionScore,
    recognitionScore: line.recognitionScore ?? null,
    minimumTokenScore: line.minimumTokenScore ?? null,
    meanTokenMargin: line.meanTokenMargin ?? null,
    eosScore: line.eosScore ?? null,
    endedWithEos: line.endedWithEos ?? null,
    source: line.source ?? null,
    preprocessing: line.preprocessing ?? null,
    orientation: line.orientation ?? null,
    deskewAngle: line.deskewAngle ?? null,
    paperScore: line.paperScore ?? null,
    uncertain: line.uncertain ?? false,
    selectionReason: line.selectionReason ?? null,
    alternatives: line.alternatives ?? [],
  })));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

/** Fingerprint benchmark content while ignoring timestamps, browser, and runtime duration. */
export function ocrBenchmarkDeterministicFingerprint(record: OcrBenchmarkRecord): string {
  return JSON.stringify(stableValue({
    schemaVersion: record.schemaVersion,
    pipelineVersion: record.pipelineVersion,
    modelRevision: record.modelRevision,
    page: record.page,
    execution: {
      provider: record.execution.provider,
      profile: record.execution.profile,
      options: record.execution.options,
    },
    output: {
      imageWidth: record.output.imageWidth,
      imageHeight: record.output.imageHeight,
      fingerprint: record.output.fingerprint,
    },
    groundTruth: record.groundTruth,
    metrics: record.metrics,
  }));
}

export function compareOcrBenchmarkRunDeterminism(
  first: OcrBenchmarkRecord[],
  second: OcrBenchmarkRecord[],
): { deterministic: boolean; differingCanvasIds: string[] } {
  const firstByCanvas = new Map(first.map((record) => [record.page.canvasId, record]));
  const secondByCanvas = new Map(second.map((record) => [record.page.canvasId, record]));
  const canvasIds = new Set([...firstByCanvas.keys(), ...secondByCanvas.keys()]);
  const differingCanvasIds = [...canvasIds].filter((canvasId) => {
    const firstRecord = firstByCanvas.get(canvasId);
    const secondRecord = secondByCanvas.get(canvasId);
    return !firstRecord
      || !secondRecord
      || ocrBenchmarkDeterministicFingerprint(firstRecord) !== ocrBenchmarkDeterministicFingerprint(secondRecord);
  }).sort();
  return { deterministic: differingCanvasIds.length === 0, differingCanvasIds };
}

export function createOcrBenchmarkRecord(options: {
  page: ViewerPage;
  manifestUrl: string;
  imageWidth?: number;
  imageHeight?: number;
  modelRevision?: string;
  provider?: string;
  profile?: NdlOcrOptions["profile"];
  ocrOptions?: NdlOcrOptions;
  stats?: OcrRunStats;
  groundTruth?: OcrGroundTruthPage;
  normalizedText?: (value: string) => string;
}): OcrBenchmarkRecord {
  const ocrOptions = options.ocrOptions
    ?? normalizeNdlOcrOptions({ profile: options.profile ?? "balanced" });
  const metrics = options.groundTruth
    ? evaluateOcrPage({
        predicted: options.page.result,
        reference: options.groundTruth,
        normalizedText: options.normalizedText
          ?? (options.groundTruth.lines.some((line) => line.normalizedText !== undefined) ? (value) => value : undefined),
        lowConfidenceThreshold: recognitionRetryThresholdForProfile(ocrOptions.profile),
      })
    : undefined;

  return {
    schemaVersion: OCR_BENCHMARK_SCHEMA_VERSION,
    pipelineVersion: options.page.ocrPipelineVersion ?? OCR_PIPELINE_VERSION,
    createdAt: new Date().toISOString(),
    modelRevision: options.modelRevision ?? options.page.ocrModelRevision ?? "unknown",
    page: {
      manifestUrl: options.manifestUrl,
      canvasId: options.page.canvasId,
      imageServiceId: options.page.imageServiceId,
      width: options.page.width,
      height: options.page.height,
    },
    execution: {
      browser: browserName(),
      provider: options.provider ?? options.page.ocrProvider ?? "unknown",
      profile: ocrOptions.profile,
      options: ocrOptions,
      ...(options.stats || options.page.ocrStats ? { stats: options.stats ?? options.page.ocrStats } : {}),
    },
    output: {
      imageWidth: options.imageWidth ?? options.page.ocrImageWidth ?? options.page.width,
      imageHeight: options.imageHeight ?? options.page.ocrImageHeight ?? options.page.height,
      fingerprint: ocrLinesFingerprint(options.page.result),
      lines: options.page.result,
    },
    ...(options.groundTruth ? { groundTruth: options.groundTruth } : {}),
    ...(metrics ? { metrics } : {}),
  };
}

export function serializeBenchmarkJson(record: OcrBenchmarkRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function serializeBenchmarkCsv(record: OcrBenchmarkRecord): string {
  const escape = (value: unknown): string => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = [
    [
      "schemaVersion",
      "pipelineVersion",
      "createdAt",
      "modelRevision",
      "browser",
      "provider",
      "modelInferenceCount",
      "maxCanvasPixels",
      "profile",
      "manifestUrl",
      "canvasId",
      "lineIndex",
      "lineId",
      "readingOrder",
      "text",
      "detectionScore",
      "recognitionScore",
      "minimumTokenScore",
      "meanTokenMargin",
      "eosScore",
      "endedWithEos",
      "source",
      "preprocessing",
      "orientation",
      "deskewAngle",
      "paperScore",
      "cer",
      "exactLineRate",
      "detectionRecall",
      "detectionPrecision",
      "detectionF1",
      "readingOrderAccuracy",
      "emptyRate",
      "lowConfidenceErrorDetectionRate",
    ],
    ...record.output.lines.map((line, index) => [
      record.schemaVersion,
      record.pipelineVersion,
      record.createdAt,
      record.modelRevision,
      record.execution.browser,
      record.execution.provider,
      record.execution.stats?.modelInferenceCount ?? "",
      record.execution.stats?.maxCanvasPixels ?? "",
      record.execution.profile,
      record.page.manifestUrl,
      record.page.canvasId,
      index,
      line.id ?? "",
      line.readingOrder ?? "",
      line.text,
      line.detectionScore,
      line.recognitionScore ?? "",
      line.minimumTokenScore ?? "",
      line.meanTokenMargin ?? "",
      line.eosScore ?? "",
      line.endedWithEos ?? "",
      line.source ?? "",
      line.preprocessing ?? "",
      line.orientation ?? "",
      line.deskewAngle ?? "",
      line.paperScore ?? "",
      record.metrics?.raw.cer ?? "",
      record.metrics?.raw.exactLineRate ?? "",
      record.metrics?.detection.recall ?? "",
      record.metrics?.detection.precision ?? "",
      record.metrics?.detection.f1 ?? "",
      record.metrics?.readingOrderAccuracy ?? "",
      record.metrics?.emptyRate ?? "",
      record.metrics?.lowConfidenceErrorDetectionRate ?? "",
    ]),
  ];
  return `${rows.map((row) => row.map(escape).join(",")).join("\n")}\n`;
}

export type OcrBenchmarkBaseline = {
  schemaVersion: number;
  kind: "ocr-baseline";
  createdAt: string;
  modelRevision: string;
  pipelineVersion: string;
  records: OcrBenchmarkRecord[];
};

export type OcrBenchmarkComparison = {
  baseline: OcrPageMetrics;
  candidate: OcrPageMetrics;
  delta: {
    cer: number;
    exactLineRate: number;
    detectionRecall: number;
    detectionPrecision: number;
    detectionF1: number;
    readingOrderAccuracy: number;
    emptyRate: number;
    lowConfidenceErrorDetectionRate: number;
  };
};

export function createOcrBenchmarkBaseline(
  records: OcrBenchmarkRecord[],
  createdAt = new Date().toISOString(),
): OcrBenchmarkBaseline {
  const first = records[0];
  return {
    schemaVersion: OCR_BENCHMARK_SCHEMA_VERSION,
    kind: "ocr-baseline",
    createdAt,
    modelRevision: first?.modelRevision ?? "unknown",
    pipelineVersion: first?.pipelineVersion ?? OCR_PIPELINE_VERSION,
    records: records.slice(),
  };
}

export function serializeOcrBenchmarkBaselineJson(baseline: OcrBenchmarkBaseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

export function compareOcrBenchmarkRecords(
  baseline: OcrBenchmarkRecord,
  candidate: OcrBenchmarkRecord,
): OcrBenchmarkComparison | null {
  if (!baseline.metrics || !candidate.metrics) return null;
  const baselineMetrics = baseline.metrics;
  const candidateMetrics = candidate.metrics;
  return {
    baseline: baselineMetrics,
    candidate: candidateMetrics,
    delta: {
      cer: candidateMetrics.raw.cer - baselineMetrics.raw.cer,
      exactLineRate: candidateMetrics.raw.exactLineRate - baselineMetrics.raw.exactLineRate,
      detectionRecall: candidateMetrics.detection.recall - baselineMetrics.detection.recall,
      detectionPrecision: candidateMetrics.detection.precision - baselineMetrics.detection.precision,
      detectionF1: candidateMetrics.detection.f1 - baselineMetrics.detection.f1,
      readingOrderAccuracy: candidateMetrics.readingOrderAccuracy - baselineMetrics.readingOrderAccuracy,
      emptyRate: candidateMetrics.emptyRate - baselineMetrics.emptyRate,
      lowConfidenceErrorDetectionRate:
        candidateMetrics.lowConfidenceErrorDetectionRate - baselineMetrics.lowConfidenceErrorDetectionRate,
    },
  };
}

export function downloadBenchmarkFile(filename: string, content: string, mimeType: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
