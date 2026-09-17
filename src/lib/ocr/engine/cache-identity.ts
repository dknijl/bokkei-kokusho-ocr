import type { NdlOcrOptions } from '../profiles.ts';
import type { OcrExecutionIdentity } from './types.ts';
import { canonicalJson } from '../honkoku/manifest.ts';
import { requireModelRevision } from './ndl-revision.ts';

export type OcrCacheKeyInput = {
  identity: OcrExecutionIdentity;
  manifestUrl: string;
  canvasId: string;
  imageServiceId: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  canvasWidth?: number;
  canvasHeight?: number;
  profile: NdlOcrOptions['profile'];
  options: NdlOcrOptions;
};

/** Versioned key only; IndexedDB and legacy migration are separate responsibilities. */
export function pageOcrCacheKey(input: OcrCacheKeyInput): string {
  const { identity } = input;
  requireModelRevision(identity.detectorRevision);
  requireModelRevision(identity.recognizerRevision);
  if (identity.engineId !== 'ndl-parseq' && identity.engineId !== 'honkoku-v19') throw new Error('Unknown OCR engine.');
  if (!identity.pipelineVersion || identity.engineId === 'honkoku-v19'
    && !/^[a-f0-9]{64}$/.test(identity.modelManifestDigest ?? '')) throw new Error('Incomplete OCR cache identity.');
  return canonicalJson([
    'bokkei-page-ocr-v2', identity.engineId, identity.detectorRevision,
    identity.recognizerRevision, identity.modelManifestDigest ?? '', identity.pipelineVersion,
    input.manifestUrl, input.canvasId, input.imageServiceId, input.imageUrl ?? '',
    input.imageWidth ?? 0, input.imageHeight ?? 0, input.canvasWidth ?? 0, input.canvasHeight ?? 0,
    input.profile, input.options,
  ]);
}
