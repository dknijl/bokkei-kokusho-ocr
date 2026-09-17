import { validatePinnedPageOcrRequest } from './engine/pin-request.ts';
import { ndlPageResult, assertResultIdentity } from './engine/result.ts';
import { recognizePageWithNdlLite } from "../ndl-ocr.ts";
import { OcrFailure } from "./network.ts";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol.ts";

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};
worker.onmessage = async ({ data }) => {
  try {
    validatePinnedPageOcrRequest(data.request);
    if (data.request.engineId !== 'ndl-parseq') throw new Error('Wrong OCR worker.');
    const result = ndlPageResult(await recognizePageWithNdlLite(data.page, data.request.options, (progress) => worker.postMessage({ id: data.id, type: 'progress', progress })));
    assertResultIdentity(result, data.request);
    worker.postMessage({ id: data.id, type: "result", result });
  } catch (error) {
    worker.postMessage({ id: data.id, type: "error", error: {
      message: error instanceof Error ? error.message : String(error),
      kind: error instanceof OcrFailure ? error.kind : "model",
    } });
  }
};
