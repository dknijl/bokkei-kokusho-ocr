import { recognizePageWithNdlLite } from "../ndl-ocr.ts";
import { OcrFailure } from "./network.ts";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol.ts";

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};
worker.onmessage = async ({ data }) => {
  try {
    const result = await recognizePageWithNdlLite(data.page, data.options, (progress) => worker.postMessage({ id: data.id, type: "progress", progress }));
    worker.postMessage({ id: data.id, type: "result", result });
  } catch (error) {
    worker.postMessage({ id: data.id, type: "error", error: {
      message: error instanceof Error ? error.message : String(error),
      kind: error instanceof OcrFailure ? error.kind : "model",
    } });
  }
};
