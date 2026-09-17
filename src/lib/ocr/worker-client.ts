import type { ViewerPage } from "../iiif.ts";
import type { PinnedPageOcrRequest, PageOcrResult, PageOcrProgress } from "./engine/types.ts";
import { validatePinnedPageOcrRequest } from "./engine/pin-request.ts";
import { assertResultIdentity, ndlPageResult } from "./engine/result.ts";

import type { WorkerResponse } from "./worker-protocol.ts";
import { chooseHonkokuRuntime } from "./models/runtime.ts";
import { honkokuEnabled } from "./engine/registry.ts";
import { abortCheck, OcrFailure } from "./network.ts";

let worker: Worker | null = null;
let engine: string | undefined;
let sequence = 0;
let busy = false;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

export const supportsOcrWorker = () => typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined";

export function disposeOcrWorker(): void {
  if (busy) return;
  clearTimeout(idleTimer);
  worker?.terminate(); worker = null;
}

/** One shared execution slot for both the page button and manifest jobs. */
export async function executeOcrPage(page: ViewerPage, request: PinnedPageOcrRequest, progress: (value: PageOcrProgress) => void, signal?: AbortSignal): Promise<PageOcrResult> {
  request = structuredClone(request);
  page = { ...page, labelTranslations: { ...page.labelTranslations }, result: [] };
  validatePinnedPageOcrRequest(request);
  if (request.engineId === 'honkoku-v19' && !honkokuEnabled()) throw new OcrFailure('Honkoku is disabled in this build.', 'model');
  abortCheck(signal);
  if (busy) throw new OcrFailure("Another OCR operation is still running", "worker");
  if (engine !== request.engineId) disposeOcrWorker();
  engine = request.engineId;
  busy = true;
  clearTimeout(idleTimer);
  try {
    if (!supportsOcrWorker()) {
      if (request.engineId !== 'ndl-parseq') throw new OcrFailure('Honkoku requires Worker and OffscreenCanvas.', 'worker');
      const { recognizePageWithNdlLite } = await import("../ndl-ocr.ts");
      const result = ndlPageResult(await recognizePageWithNdlLite(page, request.options, progress, signal));
      assertResultIdentity(result, request);
      return result;
    }
    const useGpu = request.engineId === 'honkoku-v19' && await chooseHonkokuRuntime() === 'webgpu';
    abortCheck(signal);
    const id = ++sequence;
    return await new Promise<PageOcrResult>((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener('abort', abort);
        if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; }
      };
      const abort = () => {
        worker?.terminate(); worker = null; cleanup();
        reject(new DOMException("OCR cancelled", "AbortError"));
      };
      try {
        worker ??= request.engineId === 'honkoku-v19'
          ? new Worker(new URL('./honkoku/page.worker.ts', import.meta.url), { type: 'module' })
          : new Worker(new URL('./ocr.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
          if (data.id !== id) return;
          if (data.type === "progress") { progress(data.progress); return; }
          cleanup();
          if (data.type === 'result') {
            try { assertResultIdentity(data.result, request); resolve(data.result); }
            catch (error) { worker?.terminate(); worker = null; reject(error); }
          }
          else {
            if (data.error.kind === "model" || data.error.kind === "worker") { worker?.terminate(); worker = null; }
            reject(new OcrFailure(data.error.message, data.error.kind));
          }
        };
        worker.onerror = (event) => {
          cleanup(); worker?.terminate(); worker = null;
          reject(new OcrFailure(`OCR worker failed: ${event.message}`, "worker"));
        };
        worker.onmessageerror = () => {
          cleanup(); worker?.terminate(); worker = null;
          reject(new OcrFailure("OCR worker returned unreadable data", "worker"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        worker.postMessage({ id, page, request, useGpu });
      } catch (error) {
        cleanup(); worker?.terminate(); worker = null;
        reject(new OcrFailure(`OCR worker could not start: ${String(error)}`, "worker"));
      }
    });
  } finally {
    busy = false;
    idleTimer = setTimeout(disposeOcrWorker, 120_000);
  }
}
