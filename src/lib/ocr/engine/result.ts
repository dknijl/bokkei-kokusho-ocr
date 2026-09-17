import type { NdlOcrResult } from '../../ndl-ocr.ts';
import type { PageOcrResult, PinnedPageOcrRequest } from './types.ts';
import { ndlExecutionIdentity } from './pin-request.ts';
import { canonicalJson } from '../honkoku/manifest.ts';
export function ndlPageResult(result: NdlOcrResult): PageOcrResult {
  return { ...result, identity: ndlExecutionIdentity(result.revision), lines: result.lines.map(line => ({ ...line,
    recognizerId: 'ndl-parseq', recognizerRevision: result.revision, outputFormat: 'plain', confidenceKind: 'parseq-token' })) };
}
export function assertResultIdentity(result: PageOcrResult, request: PinnedPageOcrRequest): void {
  if (canonicalJson(result.identity) !== canonicalJson(request.expectedIdentity)
    || result.revision !== request.expectedIdentity.recognizerRevision
    || result.pipelineVersion !== request.expectedIdentity.pipelineVersion
    || canonicalJson(result.options) !== canonicalJson(request.options)) throw new Error('OCR result identity mismatch.');
}
