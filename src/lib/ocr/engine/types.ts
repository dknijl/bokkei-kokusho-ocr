import type { ViewerPage } from "../../iiif.ts";
import type { TranslationKey } from "../../i18n.ts";
import type { NdlOcrOptions } from "../profiles.ts";
import type {
  OcrConfidenceKind,
  OcrEngineId,
  OcrLine,
  OcrRunStats,
} from "../types.ts";

export type {
  OcrConfidenceKind,
  OcrEngineId,
  OcrEngineComparison,
  OcrRunMode,
  OcrLine,
  OcrRegion,
  OcrRunStats,
} from "../types.ts";

export type StructuredOcrText = {
  format: "plain" | "koji";
  raw?: string;
  plain: string;
};

export type ModelLoadProgress = {
  fileRole?: string;
  percent: number;
  loadedBytes?: number;
  totalBytes?: number;
  cached?: boolean;
};

export type RecognizerDiagnostics = {
  generatedTokens?: number;
  stopReason?: "eos" | "max-length" | "degenerate-repeat";
  meanLogProbability?: number;
  minimumTokenProbability?: number;
};

export type RecognizerContext = {
  signal?: AbortSignal;
  onModelProgress?: (progress: ModelLoadProgress) => void;
};

export type RecognizerInput = {
  crop: ImageData;
  lineId: string;
};

export type RecognizerOutput = {
  text: string;
  rawKoji?: string;
  outputFormat: "plain" | "koji";
  diagnostics?: RecognizerDiagnostics;
};

export interface LineRecognizer {
  readonly id: OcrEngineId;
  readonly revision: string;

  initialize(context: RecognizerContext): Promise<void>;
  recognize(input: RecognizerInput, context?: RecognizerContext): Promise<RecognizerOutput>;
  dispose(): Promise<void>;
}

export type PageOcrResult = {
  imageWidth: number;
  imageHeight: number;
  lines: OcrLine[];

  engineId: OcrEngineId;
  engineLabel: string;
  provider: string;
  detectorRevision: string;
  recognizerRevision: string;
  modelManifestDigest?: string;
  pipelineVersion: string;

  profile: NdlOcrOptions["profile"];
  options: NdlOcrOptions;
  stats: OcrRunStats;

  /** Compatibility name used by the original NDL page pipeline. */
  revision: string;
};

export type PageOcrRequest = {
  engineId?: OcrEngineId;
  options?: NdlOcrOptions;
  modelManifestUrl?: string;
};

export type PageProgressCallback = (progress: {
  stage: "image" | "detector-model" | "recognizer-model" | "detect" | "recognize" | "retry" | "done";
  percent: number;
  messageKey: TranslationKey;
  params?: Record<string, string | number>;
  completed?: number;
  total?: number;
}) => void;

export type EngineDescriptor = {
  id: OcrEngineId;
  label: string;
  enabled: boolean;
  reason?: string;
};

export type PageRecognizer = (
  page: ViewerPage,
  request: PageOcrRequest,
  onProgress: PageProgressCallback,
  signal?: AbortSignal,
) => Promise<PageOcrResult>;
