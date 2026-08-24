const DATABASE_NAME = "bokkei-ocr-model-cache";
const DATABASE_VERSION = 1;
const STORE_NAME = "assets";

export const OCR_MODEL_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type ModelCacheEntry = {
  key: string;
  data: ArrayBuffer;
  savedAt: number;
};

export function isOcrModelCacheFresh(savedAt: number, now = Date.now()): boolean {
  return Number.isFinite(savedAt)
    && savedAt <= now
    && now - savedAt <= OCR_MODEL_CACHE_MAX_AGE_MS;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("OCR model cache open failed"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  const database = await openDatabase();
  if (!database) return undefined;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    let value: T | undefined;
    request.onsuccess = () => { value = request.result; };
    request.onerror = () => reject(request.error ?? new Error("OCR model cache request failed"));
    transaction.oncomplete = () => {
      database.close();
      resolve(value);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("OCR model cache transaction failed"));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("OCR model cache transaction aborted"));
    };
  });
}

export async function readOcrModelAsset(key: string, now = Date.now()): Promise<ArrayBuffer | null> {
  try {
    const entry = await withStore<ModelCacheEntry>("readonly", (store) => store.get(key));
    if (!entry || !(entry.data instanceof ArrayBuffer) || !isOcrModelCacheFresh(entry.savedAt, now)) {
      return null;
    }
    return entry.data.slice(0);
  } catch (error) {
    console.warn("OCR model cache read failed.", error);
    return null;
  }
}

export async function writeOcrModelAsset(
  key: string,
  data: ArrayBuffer,
  savedAt = Date.now(),
): Promise<void> {
  try {
    await withStore("readwrite", (store) => store.put({
      key,
      data: data.slice(0),
      savedAt,
    } satisfies ModelCacheEntry));
  } catch (error) {
    // A quota or private-browsing failure must not prevent the current OCR run.
    console.warn("OCR model cache write failed.", error);
  }
}

export function requestOcrModelStoragePersistence(): void {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return;
  void navigator.storage.persist().catch(() => undefined);
}
