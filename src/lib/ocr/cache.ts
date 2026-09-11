import type { NdlOcrResult } from "../ndl-ocr.ts";
import type { ViewerPage } from "../iiif.ts";
import type { NdlOcrOptions } from "./profiles.ts";

const DATABASE_NAME = "bokkei-ocr-cache";
const DATABASE_VERSION = 2;
const STORE_NAME = "page-results";

export type OcrCacheKeyInput = {
  modelRevision: string;
  pipelineVersion: string;
  manifestUrl: string;
  canvasId: string;
  imageServiceId: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  canvasWidth?: number;
  canvasHeight?: number;
  profile: NdlOcrOptions["profile"];
  options: NdlOcrOptions;
};

export type OcrCacheEntry = NdlOcrResult & {
  key: string;
  manifestUrl: string;
  canvasId: string;
  imageServiceId: string;
  savedAt: number;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export function buildOcrCacheKey(input: OcrCacheKeyInput): string {
  const optionsValue = stableValue(input.options);
  return JSON.stringify([
    input.modelRevision,
    input.pipelineVersion,
    input.manifestUrl,
    input.canvasId,
    input.imageServiceId,
    "ndl-parseq",
    input.imageUrl ?? "",
    input.imageWidth ?? 0, input.imageHeight ?? 0,
    input.canvasWidth ?? 0, input.canvasHeight ?? 0,
    input.profile,
    optionsValue,
  ]);
}

export function buildOcrCacheKeyForPage(
  page: ViewerPage,
  manifestUrl: string,
  modelRevision: string,
  pipelineVersion: string,
  options: NdlOcrOptions,
): string {
  return buildOcrCacheKey({
    modelRevision,
    pipelineVersion,
    manifestUrl,
    canvasId: page.canvasId,
    imageServiceId: page.imageServiceId,
    imageUrl: page.sourceImage || page.image,
    imageWidth: page.sourceWidth, imageHeight: page.sourceHeight,
    canvasWidth: page.width, canvasHeight: page.height,
    profile: options.profile,
    options,
  });
}

export function openOcrDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "key" });
      if (!db.objectStoreNames.contains("jobs")) db.createObjectStore("jobs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("job-pages")) db.createObjectStore("job-pages", { keyPath: ["jobId", "index"] });
    };
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onblocked = () => reject(new Error("Close other tabs to update OCR storage"));
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  const database = await openOcrDatabase();
  if (!database) return undefined;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    let value: T | undefined;
    request.onsuccess = () => { value = request.result; };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    transaction.oncomplete = () => {
      database.close();
      resolve(value);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    };
  });
}

export function cacheEntryFromResult(
  key: string,
  page: ViewerPage,
  manifestUrl: string,
  result: NdlOcrResult,
): OcrCacheEntry {
  return {
    ...result,
    key,
    manifestUrl,
    canvasId: page.canvasId,
    imageServiceId: page.imageServiceId,
    savedAt: Date.now(),
  };
}

export function resultFromOcrCache(entry: OcrCacheEntry): NdlOcrResult {
  const {
    key: _key,
    manifestUrl: _manifestUrl,
    canvasId: _canvasId,
    imageServiceId: _imageServiceId,
    savedAt: _savedAt,
    ...result
  } = entry;
  return result;
}

export async function readOcrCache(key: string): Promise<OcrCacheEntry | null> {
  try {
    return (await withStore<OcrCacheEntry>("readonly", (store) => store.get(key))) ?? null;
  } catch (error) {
    console.warn("OCR cache read failed.", error);
    return null;
  }
}

export async function writeOcrCache(entry: OcrCacheEntry): Promise<void> {
  try {
    await withStore("readwrite", (store) => store.put(entry));
  } catch (error) {
    console.warn("OCR cache write failed.", error);
  }
}

export async function deleteOcrCache(key: string): Promise<void> {
  try {
    await withStore("readwrite", (store) => store.delete(key));
  } catch (error) {
    console.warn("OCR cache delete failed.", error);
  }
}

export async function clearOcrCache(): Promise<void> {
  try {
    await withStore("readwrite", (store) => store.clear());
  } catch (error) {
    console.warn("OCR cache clear failed.", error);
  }
}
