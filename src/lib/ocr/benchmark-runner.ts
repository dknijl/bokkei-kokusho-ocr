import type { ViewerPage } from "../iiif.ts";
import type { NdlOcrProgress, NdlOcrResult } from "../ndl-ocr.ts";
import {
  compareOcrBenchmarkRecords,
  createOcrBenchmarkBaseline,
  createOcrBenchmarkRecord,
  type OcrBenchmarkBaseline,
  type OcrBenchmarkComparison,
  type OcrBenchmarkRecord,
} from "./benchmark.ts";
import type { OcrGroundTruthPage } from "./metrics.ts";
import type { NdlOcrOptions } from "./profiles.ts";

export type OcrBenchmarkProgress = {
  pageIndex: number;
  totalPages: number;
  progress: NdlOcrProgress;
};

export type OcrBenchmarkRunnerOptions = {
  pages: OcrGroundTruthPage[];
  ocrOptions: NdlOcrOptions;
  recognize: (
    page: ViewerPage,
    options: NdlOcrOptions,
    onProgress: (progress: NdlOcrProgress) => void,
    signal?: AbortSignal,
  ) => Promise<NdlOcrResult>;
  signal?: AbortSignal;
  onProgress?: (progress: OcrBenchmarkProgress) => void;
  onRecord?: (record: OcrBenchmarkRecord, pageIndex: number) => void;
};

export type OcrBenchmarkRun = {
  records: OcrBenchmarkRecord[];
  baseline: OcrBenchmarkBaseline;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("ocrCancelled", "AbortError");
}

export function viewerPageFromGroundTruth(page: OcrGroundTruthPage): ViewerPage {
  const image = page.imageServiceId
    ? `${page.imageServiceId.replace(/\/$/, "")}/full/2000,/0/default.jpg`
    : "";
  return {
    canvasId: page.canvasId,
    imageServiceId: page.imageServiceId,
    label: page.id,
    labelTranslations: { none: page.id },
    image,
    thumbnail: image,
    width: page.width,
    height: page.height,
    result: [],
  };
}

export async function runOcrBenchmarkDataset(
  options: OcrBenchmarkRunnerOptions,
): Promise<OcrBenchmarkRun> {
  const records: OcrBenchmarkRecord[] = [];
  for (let pageIndex = 0; pageIndex < options.pages.length; pageIndex += 1) {
    throwIfAborted(options.signal);
    const groundTruth = options.pages[pageIndex];
    if (!groundTruth) continue;
    const page = viewerPageFromGroundTruth(groundTruth);
    const result = await options.recognize(
      page,
      options.ocrOptions,
      (progress) => options.onProgress?.({ pageIndex, totalPages: options.pages.length, progress }),
      options.signal,
    );
    throwIfAborted(options.signal);
    const resultPage: ViewerPage = {
      ...page,
      result: result.lines,
      ocrProvider: result.provider,
      ocrModelRevision: result.revision,
      ocrPipelineVersion: result.pipelineVersion,
      ocrImageWidth: result.imageWidth,
      ocrImageHeight: result.imageHeight,
      ocrProfile: result.profile,
      ocrOptions: result.options,
      ocrStats: result.stats,
    };
    const record = createOcrBenchmarkRecord({
      page: resultPage,
      manifestUrl: groundTruth.manifestUrl,
      modelRevision: result.revision,
      provider: result.provider,
      ocrOptions: result.options,
      stats: result.stats,
      groundTruth,
    });
    records.push(record);
    options.onRecord?.(record, pageIndex);
  }

  return { records, baseline: createOcrBenchmarkBaseline(records) };
}

export function compareOcrBenchmarkBaselines(
  baseline: OcrBenchmarkBaseline,
  candidate: OcrBenchmarkBaseline,
): Array<{ canvasId: string; comparison: OcrBenchmarkComparison }> {
  const candidateByCanvas = new Map(
    candidate.records.map((record) => [record.page.canvasId, record]),
  );
  return baseline.records.flatMap((baselineRecord) => {
    const candidateRecord = candidateByCanvas.get(baselineRecord.page.canvasId);
    const comparison = candidateRecord
      ? compareOcrBenchmarkRecords(baselineRecord, candidateRecord)
      : null;
    return comparison ? [{ canvasId: baselineRecord.page.canvasId, comparison }] : [];
  });
}
