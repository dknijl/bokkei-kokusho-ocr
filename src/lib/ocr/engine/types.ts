import type { OcrLine, OcrRunStats, OcrEngineId, OcrGenerationDiagnostics } from '../types.ts';
import type { NdlOcrOptions } from '../profiles.ts';
import type { NdlOcrProgress } from '../../ndl-ocr.ts';

export type OcrExecutionIdentity = {
  engineId: OcrEngineId;
  engineLabel: string;
  detectorRevision: string;
  recognizerRevision: string;
  pipelineVersion: string;
  modelManifestDigest?: string;
  upstreamRepository?: string;
  upstreamCommit?: string;
};

export type PageOcrRequest = {
  engineId: OcrEngineId;
  options: NdlOcrOptions;
  modelManifestUrl?: string;
};

export type PinnedPageOcrRequest = PageOcrRequest & {
  schemaVersion: 1;
  modelDownloadBytes?: number;
  expectedIdentity: OcrExecutionIdentity;
};

export type PageOcrProgress = NdlOcrProgress;
export type PageOcrResult = {
  identity: OcrExecutionIdentity;
  imageWidth: number;
  imageHeight: number;
  lines: OcrLine[];
  provider: string;
  /** Compatibility alias for the recognizer revision. */
  revision: string;
  pipelineVersion: string;
  profile: NdlOcrOptions['profile'];
  options: NdlOcrOptions;
  stats: OcrRunStats;
};

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

export type RecognizerDiagnostics = OcrGenerationDiagnostics;

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


export type PageProgressCallback = (progress: PageOcrProgress) => void;
