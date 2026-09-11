import {
  resolveHonkokuModelFileUrl,
  type HonkokuModelFileRole,
  type HonkokuModelManifest,
} from "./manifest.ts";

const DATABASE_NAME = "bokkei-ocr-models";
const DATABASE_VERSION = 1;
const MODEL_STORE_NAME = "model-files";
const MANIFEST_STORE_NAME = "manifests";

type CachedModelFile = {
  key: string;
  engineId: "honkoku-v18";
  upstreamCommit: string;
  fileRole: HonkokuModelFileRole;
  sha256: string;
  bytes: number;
  data: ArrayBuffer;
  savedAt: number;
};

type CachedManifest = {
  key: string;
  manifestUrl: string;
  digest: string;
  manifest: HonkokuModelManifest;
  savedAt: number;
};

export type ModelDownloadProgress = {
  fileRole: HonkokuModelFileRole;
  percent: number;
  loadedBytes?: number;
  totalBytes?: number;
  cached: boolean;
};

export class HonkokuModelCacheError extends Error {
  constructor(
    readonly code: "quota" | "indexeddb" | "content-type" | "size" | "integrity" | "aborted",
    message: string,
  ) {
    super(message);
    this.name = "HonkokuModelCacheError";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HonkokuModelCacheError("aborted", "Honkoku model download was cancelled.");
}

function modelCacheKey(
  manifest: HonkokuModelManifest,
  role: HonkokuModelFileRole,
): string {
  return [manifest.engineId, manifest.upstreamCommit, role, manifest.files[role].sha256].join("+");
}

export function buildHonkokuModelCacheKey(
  manifest: HonkokuModelManifest,
  role: HonkokuModelFileRole,
): string {
  return modelCacheKey(manifest, role);
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(MODEL_STORE_NAME)) {
        database.createObjectStore(MODEL_STORE_NAME, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(MANIFEST_STORE_NAME)) {
        database.createObjectStore(MANIFEST_STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new HonkokuModelCacheError("indexeddb", "Could not open the Honkoku model cache."));
  });
}

async function readCachedModel(key: string): Promise<CachedModelFile | null> {
  const database = await openDatabase();
  if (!database) return null;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(MODEL_STORE_NAME, "readonly");
    const request = transaction.objectStore(MODEL_STORE_NAME).get(key);
    request.onsuccess = () => resolve((request.result as CachedModelFile | undefined) ?? null);
    request.onerror = () => reject(new HonkokuModelCacheError("indexeddb", "Could not read the Honkoku model cache."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(new HonkokuModelCacheError("indexeddb", "Could not read the Honkoku model cache."));
    };
  });
}

async function writeCachedModel(entry: CachedModelFile): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(MODEL_STORE_NAME, "readwrite");
    const request = transaction.objectStore(MODEL_STORE_NAME).put(entry);
    request.onerror = () => reject(new HonkokuModelCacheError("indexeddb", "Could not write the Honkoku model cache."));
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(new HonkokuModelCacheError("indexeddb", "Could not write the Honkoku model cache."));
    };
    transaction.onabort = () => {
      database.close();
      reject(new HonkokuModelCacheError("indexeddb", "Could not write the Honkoku model cache."));
    };
  });
}

async function deleteCachedModel(key: string): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(MODEL_STORE_NAME, "readwrite");
    const request = transaction.objectStore(MODEL_STORE_NAME).delete(key);
    request.onerror = () => reject(new HonkokuModelCacheError("indexeddb", "Could not delete the Honkoku model cache entry."));
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(new HonkokuModelCacheError("indexeddb", "Could not delete the Honkoku model cache entry."));
    };
  });
}

async function writeCachedManifest(entry: CachedManifest): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(MANIFEST_STORE_NAME, "readwrite");
    const request = transaction.objectStore(MANIFEST_STORE_NAME).put(entry);
    request.onerror = () => reject(new HonkokuModelCacheError("indexeddb", "Could not write the Honkoku manifest cache."));
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(new HonkokuModelCacheError("indexeddb", "Could not write the Honkoku manifest cache."));
    };
  });
}

export async function cacheHonkokuManifest(
  manifestUrl: string,
  manifest: HonkokuModelManifest,
  digest: string,
): Promise<void> {
  await writeCachedManifest({
    key: `${manifestUrl}+${digest}`,
    manifestUrl,
    manifest,
    digest,
    savedAt: Date.now(),
  });
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ensureStorageCapacity(bytes: number): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return;
  const estimate = await navigator.storage.estimate();
  if (estimate.quota !== undefined && estimate.usage !== undefined && estimate.usage + bytes > estimate.quota) {
    throw new HonkokuModelCacheError("quota", "Not enough browser storage for the Honkoku model file.");
  }
}

async function downloadModel(
  url: string,
  role: HonkokuModelFileRole,
  expectedBytes: number,
  expectedSha256: string,
  signal?: AbortSignal,
  onProgress?: (progress: ModelDownloadProgress) => void,
): Promise<ArrayBuffer> {
  throwIfAborted(signal);
  const response = await fetch(url, {
    signal,
    cache: "no-store",
    mode: "cors",
    headers: { accept: role === "vocab" ? "application/json" : "application/octet-stream" },
  });
  throwIfAborted(signal);
  if (!response.ok) throw new Error(`Honkoku model file request failed (HTTP ${response.status}).`);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    throw new HonkokuModelCacheError("content-type", `Honkoku model file ${role} returned HTML instead of model data.`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  const totalBytes = Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : expectedBytes;
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        throwIfAborted(signal);
        const next = await reader.read();
        if (next.done) break;
        if (next.value) {
          chunks.push(next.value);
          loadedBytes += next.value.byteLength;
          onProgress?.({
            fileRole: role,
            percent: totalBytes ? Math.min(1, loadedBytes / totalBytes) : 0,
            loadedBytes,
            totalBytes: totalBytes || undefined,
            cached: false,
          });
        }
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    const data = new Uint8Array(await response.arrayBuffer());
    chunks.push(data);
    loadedBytes = data.byteLength;
    onProgress?.({ fileRole: role, percent: 1, loadedBytes, totalBytes, cached: false });
  }

  const data = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (data.byteLength !== expectedBytes) {
    throw new HonkokuModelCacheError("size", `Honkoku model file ${role} has an unexpected byte length.`);
  }
  if (await sha256Hex(data.buffer) !== expectedSha256) {
    throw new HonkokuModelCacheError("integrity", `Honkoku model file ${role} failed SHA-256 verification.`);
  }
  onProgress?.({ fileRole: role, percent: 1, loadedBytes, totalBytes, cached: false });
  return data.buffer;
}

const pendingDownloads = new Map<string, Promise<ArrayBuffer>>();

export async function loadHonkokuModelFile(options: {
  manifest: HonkokuModelManifest;
  manifestUrl: string;
  role: HonkokuModelFileRole;
  signal?: AbortSignal;
  onProgress?: (progress: ModelDownloadProgress) => void;
}): Promise<ArrayBuffer> {
  const { manifest, manifestUrl, role, signal, onProgress } = options;
  const file = manifest.files[role];
  const key = modelCacheKey(manifest, role);
  const cached = await readCachedModel(key);
  if (cached) {
    if (cached.bytes === file.bytes && cached.sha256 === file.sha256 && await sha256Hex(cached.data) === file.sha256) {
      onProgress?.({ fileRole: role, percent: 1, loadedBytes: file.bytes, totalBytes: file.bytes, cached: true });
      return cached.data;
    }
    await deleteCachedModel(key);
  }

  const pending = pendingDownloads.get(key);
  if (pending) {
    const data = await pending;
    throwIfAborted(signal);
    onProgress?.({ fileRole: role, percent: 1, loadedBytes: file.bytes, totalBytes: file.bytes, cached: true });
    return data;
  }

  const download = (async () => {
    await ensureStorageCapacity(file.bytes);
    const data = await downloadModel(
      resolveHonkokuModelFileUrl(manifestUrl, file),
      role,
      file.bytes,
      file.sha256,
      signal,
      onProgress,
    );
    await writeCachedModel({
      key,
      engineId: manifest.engineId,
      upstreamCommit: manifest.upstreamCommit,
      fileRole: role,
      sha256: file.sha256,
      bytes: file.bytes,
      data,
      savedAt: Date.now(),
    });
    return data;
  })();
  pendingDownloads.set(key, download);
  try {
    return await download;
  } finally {
    if (pendingDownloads.get(key) === download) pendingDownloads.delete(key);
  }
}

export async function clearHonkokuModelCache(): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([MODEL_STORE_NAME, MANIFEST_STORE_NAME], "readwrite");
    transaction.objectStore(MODEL_STORE_NAME).clear();
    transaction.objectStore(MANIFEST_STORE_NAME).clear();
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(new HonkokuModelCacheError("indexeddb", "Could not clear the Honkoku model cache."));
    };
  });
}
