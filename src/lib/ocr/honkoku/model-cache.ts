import { sha256, type HonkokuModelFile } from './manifest.ts';
export class HonkokuModelSizeError extends Error {
  constructor() { super('Honkoku model byte length mismatch.'); this.name = 'HonkokuModelSizeError'; }
}
const DB = 'bokkei-honkoku-models-v1';
const inFlight = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
const assetKey = (file: HonkokuModelFile) => `honkoku-v19:${file.url}:${file.sha256}:${file.bytes}`;
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('assets');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function cachedValue(key: string): Promise<ArrayBuffer | Blob | undefined> {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction('assets').objectStore('assets').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }); } finally { db.close(); }
}
async function cached(key: string): Promise<ArrayBuffer | undefined> {
  const value = await cachedValue(key);
  return value instanceof Blob ? value.arrayBuffer() : value;
}
async function persist(key: string, bytes?: ArrayBuffer): Promise<void> {
  const db = await database();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('assets', 'readwrite');
    if (bytes) tx.objectStore('assets').put(new Blob([bytes]), key); else tx.objectStore('assets').delete(key);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  }); } finally { db.close(); }
}
export async function validateModelBytes(data: ArrayBuffer, file: HonkokuModelFile): Promise<void> {
  if (data.byteLength !== file.bytes) throw new HonkokuModelSizeError();
  if (await sha256(new Uint8Array(data)) !== file.sha256) throw new Error('Honkoku model SHA-256 mismatch.');
}
async function downloadHonkokuAsset(file: HonkokuModelFile, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  const key = assetKey(file);
  const value = await cached(key);
  if (value) {
    try { await validateModelBytes(value, file); signal?.throwIfAborted(); return new Uint8Array(value); }
    catch (error) { signal?.throwIfAborted(); await persist(key); }
  }
  const estimate = await navigator.storage?.estimate?.();
  if (estimate?.quota && file.bytes > estimate.quota - (estimate.usage ?? 0)) {
    throw new Error(`Honkoku storage quota: need ${Math.ceil(file.bytes / 1048576)} MiB free.`);
  }
  const timeout = AbortSignal.timeout(180_000);
  const response = await fetch(file.url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, mode: 'cors', credentials: 'omit' });
  if (!response.ok) throw new Error(`Honkoku model download: HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty Honkoku model response.');
  const bytes = new Uint8Array(file.bytes);
  let offset = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > bytes.length) throw new HonkokuModelSizeError();
      bytes.set(value, offset); offset += value.length;
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  if (offset !== bytes.length) throw new HonkokuModelSizeError();
  await validateModelBytes(bytes.buffer, file);
  signal?.throwIfAborted();
  await persist(key, bytes.buffer);
  return bytes;
}

/** Shared downloads are owned by the worker; an abort terminates the worker and all its fetches. */
export function loadHonkokuAsset(file: HonkokuModelFile, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  if (signal) return downloadWithSizeRetry(file, signal);
  const key = assetKey(file);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = downloadWithSizeRetry(file).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}
export async function ensureHonkokuStorage(files: HonkokuModelFile[]): Promise<void> {
  let needed = 0;
  for (const file of files) {
    const value = await cachedValue(assetKey(file));
    if (!value || (value instanceof Blob ? value.size : value.byteLength) !== file.bytes) needed += file.bytes;
  }
  const estimate = await navigator.storage?.estimate?.();
  if (estimate?.quota && needed > estimate.quota - (estimate.usage ?? 0)) {
    throw new Error(`Honkoku storage quota: need ${Math.ceil(needed / 1048576)} MiB free.`);
  }
}
/** Explicit maintenance operation; no automatic deletion of another model's cache. */
export async function pruneHonkokuModels(retained: HonkokuModelFile[]): Promise<void> {
  const keys = new Set(retained.map(assetKey));
  const db = await database();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('assets', 'readwrite');
    const cursor = tx.objectStore('assets').openKeyCursor();
    cursor.onsuccess = () => { const row = cursor.result; if (!row) return; if (!keys.has(String(row.key))) tx.objectStore('assets').delete(row.key); row.continue(); };
    tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
  }); } finally { db.close(); }
}

async function downloadWithSizeRetry(file: HonkokuModelFile, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  try { return await downloadHonkokuAsset(file, signal); }
  catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof HonkokuModelSizeError)) throw error;
    return downloadHonkokuAsset(file, signal);
  }
}
