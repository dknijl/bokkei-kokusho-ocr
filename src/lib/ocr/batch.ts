import type { ViewerManifest, ViewerPage } from "../iiif.ts";
import type { NdlOcrResult, NdlOcrProgress } from "../ndl-ocr.ts";
import { openOcrDatabase, buildOcrCacheKeyForPage, cacheEntryFromResult, readOcrCache, resultFromOcrCache, type OcrCacheEntry } from "./cache.ts";
import { OCR_PIPELINE_VERSION } from "./benchmark.ts";
import { ndlModelRevision } from "./model-revision.ts";
import { normalizeNdlOcrOptions, type NdlOcrOptions } from "./profiles.ts";
import { abortCheck, OcrFailure } from "./network.ts";
import { resolvePageImageSource } from "./image-source.ts";

export type JobStatus = "ready" | "running" | "paused" | "cancelled" | "completed" | "completed-with-errors";
export type JobPageStatus = "pending" | "done" | "no-text-detected" | "failed" | "unsupported";
export type OcrJob = {
  id: string;
  manifestUrl: string;
  title: string;
  recordId: string;
  modelRevision: string;
  pipelineVersion: string;
  options: NdlOcrOptions;
  total: number;
  completed: number;
  failed: number;
  nextIndex: number;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
};
export type OcrJobPage = {
  jobId: string;
  index: number;
  page: ViewerPage;
  status: JobPageStatus;
  result?: NdlOcrResult;
  error?: string;
};

export interface JobStore {
  getPage(jobId: string, index: number): Promise<OcrJobPage>;
  saveJob(job: OcrJob): Promise<void>;
  commitPage(job: OcrJob, page: OcrJobPage, cache?: OcrCacheEntry): Promise<void>;
}

async function transaction<T>(stores: string[], mode: IDBTransactionMode, operation: (tx: IDBTransaction, setValue: (value: T) => void) => void): Promise<T> {
  let db: IDBDatabase | null;
  try { db = await openOcrDatabase(); }
  catch (error) { throw new OcrFailure(`OCR storage unavailable: ${String(error)}`, "storage"); }
  if (!db) throw new OcrFailure("IndexedDB is unavailable", "storage");
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let value: T;
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onabort = tx.onerror = () => { db.close(); reject(new OcrFailure(`OCR result was not saved: ${tx.error?.message ?? "transaction aborted"}`, "storage")); };
    try { operation(tx, (next) => { value = next; }); }
    catch (error) { tx.abort(); db.close(); reject(new OcrFailure(`OCR result was not saved: ${String(error)}`, "storage")); }
  });
}

export const indexedDbJobStore: JobStore = {
  async getPage(jobId, index) {
    const row = await transaction<OcrJobPage | undefined>(["job-pages"], "readonly", (tx, set) => {
      const request = tx.objectStore("job-pages").get([jobId, index]);
      request.onsuccess = () => set(request.result);
    });
    if (!row) throw new OcrFailure(`Saved Canvas ${index + 1} is missing`, "storage");
    return row;
  },
  saveJob: (job) => transaction(["jobs"], "readwrite", (tx) => { tx.objectStore("jobs").put(job); }),
  commitPage: (job, page, cache) => transaction(["jobs", "job-pages", "page-results"], "readwrite", (tx) => {
    tx.objectStore("job-pages").put(page);
    tx.objectStore("jobs").put(job);
    if (cache) tx.objectStore("page-results").put(cache);
  }),
};

export async function createOcrJob(manifest: ViewerManifest, options: NdlOcrOptions): Promise<OcrJob> {
  const job: OcrJob = {
    id: crypto.randomUUID(), manifestUrl: manifest.url, title: manifest.title, recordId: manifest.recordId,
    modelRevision: ndlModelRevision(options.modelRevision), pipelineVersion: OCR_PIPELINE_VERSION, options: normalizeNdlOcrOptions(options),
    total: manifest.pages.length, completed: 0, failed: 0, nextIndex: 0, status: "ready", createdAt: Date.now(), updatedAt: Date.now(),
  };
  await transaction(["jobs", "job-pages"], "readwrite", (tx) => {
    tx.objectStore("jobs").put(job);
    manifest.pages.forEach((page, index) => {
      const requestPage: ViewerPage = {
        canvasId: page.canvasId, canvasIndex: page.canvasIndex ?? index,
        imageServiceId: page.imageServiceId, image: page.image, sourceImage: page.sourceImage,
        sourceWidth: page.sourceWidth, sourceHeight: page.sourceHeight,
        width: page.width, height: page.height, label: page.label, labelTranslations: { ...page.labelTranslations },
        thumbnail: page.thumbnail, ocrAvailability: page.ocrAvailability, unsupportedReason: page.unsupportedReason, result: [],
      };
      tx.objectStore("job-pages").put({ jobId: job.id, index, page: requestPage, status: "pending" } satisfies OcrJobPage);
    });
  });
  return job;
}

export async function latestOcrJob(manifestUrl: string): Promise<OcrJob | null> {
  return transaction(["jobs"], "readonly", (tx, set) => {
    let latest: OcrJob | null = null;
    const request = tx.objectStore("jobs").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { set(latest); return; }
      const job = cursor.value as OcrJob;
      if (job.manifestUrl === manifestUrl && (!latest || job.createdAt > latest.createdAt)) latest = job;
      cursor.continue();
    };
  });
}

export async function prepareOcrCache(page: ViewerPage, manifestUrl: string, options: NdlOcrOptions, signal?: AbortSignal): Promise<{ page: ViewerPage; key: string }> {
  const source = await resolvePageImageSource(page, options, signal);
  const prepared = { ...page, sourceWidth: source.width, sourceHeight: source.height };
  return { page: prepared, key: buildOcrCacheKeyForPage(prepared, manifestUrl, ndlModelRevision(options.modelRevision), OCR_PIPELINE_VERSION, options) };
}

export type BatchRecognizer = (page: ViewerPage, options: NdlOcrOptions, progress: (value: NdlOcrProgress) => void, signal?: AbortSignal) => Promise<NdlOcrResult>;

export class BatchController {
  private controller = new AbortController();
  readonly signal = this.controller.signal;
  private pauseRequested = false;
  pause(): void { this.pauseRequested = true; }
  cancel(): void { this.controller.abort(); }

  async run(initial: OcrJob, dependencies: {
    store?: JobStore;
    recognize: BatchRecognizer;
    onChange: (job: OcrJob, progress?: NdlOcrProgress) => void;
    onPageSaved?: (page: OcrJobPage) => void;
    retryFailures?: boolean;
    prepare?: typeof prepareOcrCache;
    readCache?: typeof readOcrCache;
  }): Promise<OcrJob> {
    const store = dependencies.store ?? indexedDbJobStore;
    if (initial.modelRevision !== ndlModelRevision(initial.options.modelRevision) || initial.pipelineVersion !== OCR_PIPELINE_VERSION) {
      throw new OcrFailure("This saved job uses a different OCR version. Export it or start a new job.", "model");
    }
    let job: OcrJob = { ...initial, status: "running", error: undefined, updatedAt: Date.now() };
    const notify = (progress?: NdlOcrProgress) => dependencies.onChange({ ...job }, progress);
    await store.saveJob(job);
    notify();
    try {
      for (let index = 0; index < job.total; index++) {
        abortCheck(this.controller.signal);
        if (this.pauseRequested) { job.status = "paused"; break; }
        const row = await store.getPage(job.id, index);
        if (row.status !== "pending" && !(dependencies.retryFailures && row.status === "failed")) continue;
        job.nextIndex = index;
        notify();
        let cache: OcrCacheEntry | undefined;
        let next: OcrJobPage;
        if (row.page.ocrAvailability === "unsupported") {
          next = { ...row, status: "unsupported", error: row.page.unsupportedReason };
        } else {
          try {
            const prepared = await (dependencies.prepare ?? prepareOcrCache)(row.page, job.manifestUrl, job.options, this.controller.signal);
            const cached = await (dependencies.readCache ?? readOcrCache)(prepared.key);
            abortCheck(this.controller.signal);
            const result = cached ? resultFromOcrCache(cached)
              : await dependencies.recognize(prepared.page, job.options, notify, this.controller.signal);
            abortCheck(this.controller.signal);
            if (result.revision !== job.modelRevision || result.pipelineVersion !== job.pipelineVersion) {
              throw new OcrFailure("OCR result does not match the saved job's model and pipeline version", "model");
            }
            prepared.page.sourceWidth = result.imageWidth;
            prepared.page.sourceHeight = result.imageHeight;
            const key = buildOcrCacheKeyForPage(prepared.page, job.manifestUrl, job.modelRevision, job.pipelineVersion, job.options);
            cache = cacheEntryFromResult(key, prepared.page, job.manifestUrl, result);
            next = { ...row, page: prepared.page, status: result.lines.length ? "done" : "no-text-detected", result, error: undefined };
          } catch (error) {
            abortCheck(this.controller.signal);
            if (!(error instanceof OcrFailure) || !["image", "unsupported"].includes(error.kind)) throw error;
            next = { ...row, status: error.kind === "unsupported" ? "unsupported" : "failed", error: error.message };
          }
        }
        const wasFailure = row.status === "failed";
        const isFailure = next.status === "failed" || next.status === "unsupported";
        const committed = { ...job, completed: job.completed + (row.status === "pending" ? 1 : 0),
          failed: job.failed + Number(isFailure) - Number(wasFailure), nextIndex: index + 1, updatedAt: Date.now() };
        await store.commitPage(committed, next, cache);
        job = committed;
        notify();
        dependencies.onPageSaved?.(next);
      }
      if (job.status === "running") job.status = job.failed ? "completed-with-errors" : "completed";
      if (job.completed < job.total && job.status !== "paused") job.status = "paused";
      await store.saveJob(job);
    } catch (error) {
      job.status = this.controller.signal.aborted ? "cancelled" : "paused";
      job.error = this.controller.signal.aborted ? undefined : error instanceof Error ? error.message : String(error);
      // A failed checkpoint must never advance the reported completed count.
      try { await store.saveJob(job); } catch { /* Keep the last durable checkpoint. */ }
      notify();
      if (!this.controller.signal.aborted) throw error;
    }
    notify();
    return job;
  }
}
