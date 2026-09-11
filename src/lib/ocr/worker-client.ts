import type { ViewerPage } from "../iiif.ts";
import type { NdlOcrOptions } from "./profiles.ts";
import type { NdlOcrResult, NdlOcrProgress } from "../ndl-ocr.ts";
import type { WorkerResponse } from "./worker-protocol.ts";
import { abortCheck, OcrFailure } from "./network.ts";

let worker: Worker | null = null;
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
export async function executeOcrPage(page: ViewerPage, options: NdlOcrOptions, progress: (value: NdlOcrProgress) => void, signal?: AbortSignal): Promise<NdlOcrResult> {
  abortCheck(signal);
  if (busy) throw new OcrFailure("Another OCR operation is still running", "worker");
  busy = true;
  clearTimeout(idleTimer);
  try {
    if (!supportsOcrWorker()) {
      const { recognizePageWithNdlLite } = await import("../ndl-ocr.ts");
      return await recognizePageWithNdlLite(page, options, progress, signal);
    }
    const id = ++sequence;
    return await new Promise<NdlOcrResult>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const abort = () => {
        worker?.terminate(); worker = null; cleanup();
        reject(new DOMException("OCR cancelled", "AbortError"));
      };
      try {
        worker ??= new Worker(new URL("./ocr.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
          if (data.id !== id) return;
          if (data.type === "progress") { progress(data.progress); return; }
          cleanup();
          if (data.type === "result") resolve(data.result);
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
        worker.postMessage({ id, page, options });
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
