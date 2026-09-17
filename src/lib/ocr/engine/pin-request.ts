import { loadHonkokuManifest } from '../honkoku/default-manifest.ts';
import { resolveLatestNdlModelRevision } from '../model-source.ts';
import { honkokuEnabled, honkokuManifestUrl } from './registry.ts';
import { OCR_PIPELINE_VERSION } from '../benchmark.ts';
import { normalizeNdlOcrOptions } from '../profiles.ts';
import { NDL_UPSTREAM_REPOSITORY, requireModelRevision } from './ndl-revision.ts';
import { requireHttpsUrl, totalHonkokuModelBytes } from '../honkoku/manifest.ts';
import type { OcrExecutionIdentity, PageOcrRequest, PinnedPageOcrRequest } from './types.ts';

export function ndlExecutionIdentity(revision: string): OcrExecutionIdentity {
  requireModelRevision(revision);
  return {
    engineId: 'ndl-parseq', engineLabel: 'NDL古典籍OCR-Lite',
    detectorRevision: revision, recognizerRevision: revision, pipelineVersion: OCR_PIPELINE_VERSION,
    upstreamRepository: NDL_UPSTREAM_REPOSITORY, upstreamCommit: revision,
  };
}

export async function pinPageOcrRequest(request: PageOcrRequest, signal?: AbortSignal): Promise<PinnedPageOcrRequest> {
  signal?.throwIfAborted();
  if (request.engineId !== 'ndl-parseq' && request.engineId !== 'honkoku-v19') throw new Error('Unknown OCR engine.');
  if (request.engineId === 'honkoku-v19' && !honkokuEnabled()) throw new Error('Honkoku is disabled in this build.');
  const options = { ...request.options };
  const revision = options.modelRevision === undefined
    ? await resolveLatestNdlModelRevision(signal) : requireModelRevision(options.modelRevision);
  signal?.throwIfAborted();
  if (request.engineId === 'honkoku-v19') {
    const url = request.modelManifestUrl ?? honkokuManifestUrl();
    const { manifest, digest } = await loadHonkokuManifest(url, signal);
    signal?.throwIfAborted();
    return {
      schemaVersion: 1, engineId: 'honkoku-v19', modelManifestUrl: url, modelDownloadBytes: totalHonkokuModelBytes(manifest),
      options: { ...normalizeNdlOcrOptions(options), modelRevision: revision },
      expectedIdentity: {
        engineId: 'honkoku-v19', engineLabel: 'みんなで翻刻OCR v19', detectorRevision: revision,
        recognizerRevision: manifest.upstreamCommit, pipelineVersion: OCR_PIPELINE_VERSION,
        upstreamRepository: manifest.upstreamRepository, upstreamCommit: manifest.upstreamCommit, modelManifestDigest: digest,
      },
    };
  }
  return {
    schemaVersion: 1, engineId: 'ndl-parseq',
    options: { ...normalizeNdlOcrOptions(options), modelRevision: revision },
    expectedIdentity: ndlExecutionIdentity(revision),
  };
}

export function validatePinnedPageOcrRequest(request: PinnedPageOcrRequest): void {
  if (request.schemaVersion !== 1 || !request.expectedIdentity
    || request.engineId !== request.expectedIdentity.engineId
    || request.expectedIdentity.pipelineVersion !== OCR_PIPELINE_VERSION) throw new Error('Incompatible OCR request identity.');
  const identity = request.expectedIdentity;
  requireModelRevision(identity.detectorRevision);
  requireModelRevision(identity.recognizerRevision);
  if (request.options.modelRevision !== identity.detectorRevision) throw new Error('Detector revision mismatch.');
  if (request.engineId === 'ndl-parseq') {
    if (identity.recognizerRevision !== identity.detectorRevision || identity.modelManifestDigest
      || identity.upstreamRepository !== NDL_UPSTREAM_REPOSITORY || identity.upstreamCommit !== identity.recognizerRevision
      || identity.engineLabel !== ndlExecutionIdentity(identity.recognizerRevision).engineLabel) {
      throw new Error('NDL identity mismatch.');
    }
  } else if (request.engineId === 'honkoku-v19') {
    if (identity.engineLabel !== 'みんなで翻刻OCR v19' || !/^[a-f0-9]{64}$/.test(identity.modelManifestDigest ?? '')) {
      throw new Error('Missing Honkoku manifest identity.');
    }
    if (request.modelManifestUrl !== undefined) requireHttpsUrl(request.modelManifestUrl);
  } else {
    throw new Error('Unknown OCR engine.');
  }
}

/** Revalidate persisted/worker identity before any model execution. No NDL fallback. */
export async function verifyPinnedHonkokuManifest(request: PinnedPageOcrRequest, signal?: AbortSignal) {
  validatePinnedPageOcrRequest(request);
  if (request.engineId !== 'honkoku-v19') throw new Error('Expected a Honkoku request.');
  signal?.throwIfAborted();
  const result = await loadHonkokuManifest(request.modelManifestUrl, signal);
  const identity = request.expectedIdentity;
  if (result.digest !== identity.modelManifestDigest
    || result.manifest.upstreamCommit !== identity.recognizerRevision
    || result.manifest.upstreamCommit !== identity.upstreamCommit
    || result.manifest.upstreamRepository !== identity.upstreamRepository) {
    throw new Error('Honkoku manifest changed. Start a new OCR job.');
  }
  return result.manifest;
}
