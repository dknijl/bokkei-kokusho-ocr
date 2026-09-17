import type { ViewerManifest, ViewerPage } from "../iiif.ts";
import type { PageOcrResult, PageOcrProgress, PinnedPageOcrRequest, OcrExecutionIdentity } from "./engine/types.ts";
import { ndlExecutionIdentity, validatePinnedPageOcrRequest, verifyPinnedHonkokuManifest } from "./engine/pin-request.ts";
import { assertResultIdentity, ndlPageResult } from "./engine/result.ts";
import { canonicalJson } from "./honkoku/manifest.ts";
import { openOcrDatabase, buildOcrCacheKeyForPage, cacheEntryFromResult, readOcrCache, resultFromOcrCache, type OcrCacheEntry } from "./cache.ts";
import { OCR_PIPELINE_VERSION } from "./benchmark.ts";
import { ndlModelRevision } from "./model-revision.ts";
import { normalizeNdlOcrOptions, type NdlOcrOptions } from "./profiles.ts";
import { abortCheck, OcrFailure } from "./network.ts";
import { resolvePageImageSource } from "./image-source.ts";

export type JobStatus = "ready" | "running" | "paused" | "cancelled" | "completed" | "completed-with-errors";
export type JobPageStatus = "pending" | "done" | "no-text-detected" | "failed" | "unsupported";
export type OcrJob = {
  schemaVersion: 2;
  request: PinnedPageOcrRequest;
  identity: OcrExecutionIdentity;
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
  result?: PageOcrResult;
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
    if (row.result && !row.result.identity && row.result.pipelineVersion === OCR_PIPELINE_VERSION) {
      row.result = ndlPageResult(row.result as import("../ndl-ocr.ts").NdlOcrResult);
    }
    return row;
  },
  saveJob: (job) => transaction(["jobs"], "readwrite", (tx) => { tx.objectStore("jobs").put(job); }),
  commitPage: (job, page, cache) => transaction(["jobs", "job-pages", "page-results"], "readwrite", (tx) => {
    tx.objectStore("job-pages").put(page);
    tx.objectStore("jobs").put(job);
    if (cache) tx.objectStore("page-results").put(cache);
  }),
};

export async function createOcrJob(manifest: ViewerManifest, request: PinnedPageOcrRequest): Promise<OcrJob> {
  request = structuredClone(request);
  validatePinnedPageOcrRequest(request);
  const options = request.options;
  const job: OcrJob = {
    schemaVersion: 2, request, identity: request.expectedIdentity,
    id: crypto.randomUUID(), manifestUrl: manifest.url, title: manifest.title, recordId: manifest.recordId,
    modelRevision: request.expectedIdentity.recognizerRevision, pipelineVersion: OCR_PIPELINE_VERSION, options: normalizeNdlOcrOptions(options),
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

export async function prepareOcrCache(page: ViewerPage, manifestUrl: string, request: PinnedPageOcrRequest, signal?: AbortSignal): Promise<{ page: ViewerPage; key: string }> {
  const options = request.options;
  const source = await resolvePageImageSource(page, options, signal);
  const prepared = { ...page, sourceWidth: source.width, sourceHeight: source.height };
  return { page: prepared, key: buildOcrCacheKeyForPage(prepared, manifestUrl, ndlModelRevision(options.modelRevision), OCR_PIPELINE_VERSION, options, request.expectedIdentity) };
}

export type BatchRecognizer = (page: ViewerPage, request: PinnedPageOcrRequest, progress: (value: PageOcrProgress) => void, signal?: AbortSignal) => Promise<PageOcrResult>;

export class BatchController {
  private controller = new AbortController();
  readonly signal = this.controller.signal;
  private pauseRequested = false;
  pause(): void { this.pauseRequested = true; }
  cancel(): void { this.controller.abort(); }

  async run(initial: OcrJob, dependencies: {
    store?: JobStore;
    recognize: BatchRecognizer;
    onChange: (job: OcrJob, progress?: PageOcrProgress) => void;
    onPageSaved?: (page: OcrJobPage) => void;
    retryFailures?: boolean;
    prepare?: typeof prepareOcrCache;
    readCache?: typeof readOcrCache;
  }): Promise<OcrJob> {
    const store = dependencies.store ?? indexedDbJobStore;
    initial = migrateOcrJob(initial);
    if (initial.request.engineId === 'honkoku-v19') await verifyPinnedHonkokuManifest(initial.request, this.signal);
    let job: OcrJob = { ...initial, status: "running", error: undefined, updatedAt: Date.now() };
    const notify = (progress?: PageOcrProgress) => dependencies.onChange({ ...job }, progress);
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
            const prepared = await (dependencies.prepare ?? prepareOcrCache)(row.page, job.manifestUrl, job.request, this.controller.signal);
            const cached = await (dependencies.readCache ?? readOcrCache)(prepared.key);
            abortCheck(this.controller.signal);
            const result = cached ? resultFromOcrCache(cached)
              : await dependencies.recognize(prepared.page, job.request, notify, this.controller.signal);
            abortCheck(this.controller.signal);
            assertResultIdentity(result, job.request);
            prepared.page.sourceWidth = result.imageWidth;
            prepared.page.sourceHeight = result.imageHeight;
            const key = buildOcrCacheKeyForPage(prepared.page, job.manifestUrl, job.modelRevision, job.pipelineVersion, job.options, job.identity);
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

/** Old jobs are admitted only with a complete, internally consistent NDL identity. */
export function migrateOcrJob(value: unknown): OcrJob {
  if (!value || typeof value !== 'object') throw new Error('Invalid saved OCR job.');
  const job = structuredClone(value) as OcrJob;
  if (job.schemaVersion === undefined) {
    if (!job.options || job.options.modelRevision !== job.modelRevision || job.pipelineVersion !== OCR_PIPELINE_VERSION) {
      throw new Error('This saved job is incompatible. Start a new OCR job.');
    }
    job.identity = ndlExecutionIdentity(job.modelRevision);
    job.request = { schemaVersion: 1, engineId: 'ndl-parseq', options: normalizeNdlOcrOptions(job.options), expectedIdentity: job.identity };
    job.schemaVersion = 2;
  }
  if (job.schemaVersion !== 2) throw new Error('Unsupported OCR job version.');
  validatePinnedPageOcrRequest(job.request);
  if (canonicalJson(job.identity) !== canonicalJson(job.request.expectedIdentity)
    || canonicalJson(job.options) !== canonicalJson(job.request.options)
    || job.pipelineVersion !== job.identity.pipelineVersion || job.modelRevision !== job.identity.recognizerRevision) {
    throw new Error('Saved OCR job identity mismatch.');
  }
  return job;
}
export function isResumableOcrJob(value: unknown): boolean {
  try { migrateOcrJob(value); return true; } catch { return false; }
}
