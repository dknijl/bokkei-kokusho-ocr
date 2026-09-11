import type { ViewerPage } from "./iiif.ts";
import {
  recognizePageWithNdlLite,
  NDL_MODEL_REVISION,
  type NdlOcrProgress,
} from "./ndl-ocr.ts";
import { OCR_PIPELINE_VERSION } from "./ocr/benchmark.ts";
import { HONKOKU_V18_MANIFEST_URL, assertHonkokuV18Configured } from "./ocr/engine/feature.ts";
import { DEFAULT_NDL_OCR_OPTIONS, normalizeNdlOcrOptions } from "./ocr/profiles.ts";
import { ndlModelRevision } from "./ocr/model-revision.ts";
import type {
  PageOcrRequest,
  PageOcrResult,
  PageProgressCallback,
} from "./ocr/engine/types.ts";
import {
  HONKOKU_V18_RECOGNIZER_REVISION,
  recognizePageWithHonkokuV18,
} from "./ocr/recognizers/honkoku-v18.ts";
import { fetchHonkokuModelManifest } from "./ocr/models/manifest.ts";
import type { OcrEngineId } from "./ocr/types.ts";

export type PageOcrCacheIdentity = {
  engineId: OcrEngineId;
  recognizerRevision: string;
  detectorRevision: string;
  modelManifestDigest?: string;
  pipelineVersion: string;
};

export async function getPageOcrCacheIdentity(
  engineId: OcrEngineId,
  manifestUrl = HONKOKU_V18_MANIFEST_URL,
  signal?: AbortSignal,
  detectorRevision = NDL_MODEL_REVISION,
): Promise<PageOcrCacheIdentity> {
  const revision = ndlModelRevision(detectorRevision);
  if (engineId === "ndl-parseq") {
    return {
      engineId,
      recognizerRevision: revision,
      detectorRevision: revision,
      pipelineVersion: OCR_PIPELINE_VERSION,
    };
  }

  assertHonkokuV18Configured(manifestUrl);
  const { digest } = await fetchHonkokuModelManifest(manifestUrl, signal);
  return {
    engineId,
    recognizerRevision: HONKOKU_V18_RECOGNIZER_REVISION,
    detectorRevision: revision,
    modelManifestDigest: digest,
    pipelineVersion: OCR_PIPELINE_VERSION,
  };
}

function ndlProgress(progress: NdlOcrProgress): Parameters<PageProgressCallback>[0] {
  return {
    ...progress,
    stage: progress.stage === "models" ? "recognizer-model" : progress.stage,
  };
}

function asPageResult(result: Awaited<ReturnType<typeof recognizePageWithNdlLite>>): PageOcrResult {
  return {
    ...result,
    engineId: "ndl-parseq",
    engineLabel: "NDL古典籍OCR-Lite",
    detectorRevision: result.revision,
    recognizerRevision: result.revision,
    revision: result.revision,
  };
}

export async function recognizePage(
  page: ViewerPage,
  request: PageOcrRequest = {},
  onProgress: PageProgressCallback = () => undefined,
  signal?: AbortSignal,
): Promise<PageOcrResult> {
  const options = normalizeNdlOcrOptions(request.options ?? DEFAULT_NDL_OCR_OPTIONS);
  if ((request.engineId ?? "ndl-parseq") === "ndl-parseq") {
    const result = await recognizePageWithNdlLite(
      page,
      options,
      (progress) => onProgress(ndlProgress(progress)),
      signal,
    );
    return asPageResult(result);
  }

  return recognizePageWithHonkokuV18(
    page,
    options,
    onProgress,
    signal,
    request.modelManifestUrl,
  );
}

export { OCR_PIPELINE_VERSION };
