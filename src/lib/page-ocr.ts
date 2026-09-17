import type { ViewerPage } from './iiif.ts';
import type { PageOcrRequest, PageOcrProgress } from './ocr/engine/types.ts';
import { pinPageOcrRequest, ndlExecutionIdentity } from './ocr/engine/pin-request.ts';
import { executeOcrPage } from './ocr/worker-client.ts';
import { DEFAULT_NDL_OCR_OPTIONS } from './ocr/profiles.ts';
export { executeOcrPage };
export type { PageOcrResult, PageOcrProgress } from './ocr/engine/types.ts';
export { OCR_PIPELINE_VERSION } from './ocr/benchmark.ts';
export async function recognizePage(page: ViewerPage, request: Partial<PageOcrRequest> = {}, progress: (p: PageOcrProgress) => void = () => {}, signal?: AbortSignal) {
  const pinned = await pinPageOcrRequest({ ...request, engineId: request.engineId ?? 'ndl-parseq', options: { ...DEFAULT_NDL_OCR_OPTIONS, ...request.options } }, signal);
  const result = await executeOcrPage(page, pinned, progress, signal);
  return { ...result, ...result.identity };
}
export async function getPageOcrCacheIdentity(engineId: PageOcrRequest['engineId'], modelManifestUrl?: string, signal?: AbortSignal, detectorRevision?: string) {
  if (engineId === 'ndl-parseq' && detectorRevision) return ndlExecutionIdentity(detectorRevision);
  return (await pinPageOcrRequest({ engineId, modelManifestUrl, options: { ...DEFAULT_NDL_OCR_OPTIONS, modelRevision: detectorRevision } }, signal)).expectedIdentity;
}
