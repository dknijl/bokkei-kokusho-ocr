export const HONKOKU_V19_UPSTREAM_COMMIT = '24469701412edda5be26c89784a29c7525bbb899';
export const HONKOKU_UPSTREAM_REPOSITORY = 'yuta1984/honkoku-ocr-web';
export const HONKOKU_RUNTIME = {
  inputHeight: 256, inputWidth: 2048, maxGeneratedTokens: 192,
  decoderLayers: 6, vocabularySize: 7710,
} as const;
export const HONKOKU_FILE_NAMES = {
  encoderInt8: 'kuzushiji-v19-encoder-int8.onnx',
  encoderFp16: 'kuzushiji-v19-encoder-fp16.onnx',
  decoderPrefillInt8: 'kuzushiji-v19-decoder-prefill-int8.onnx',
  decoderStepInt8: 'kuzushiji-v19-decoder-step-int8.onnx',
  vocab: 'kuzushiji-vocab-v19.json',
} as const;
export type HonkokuModelRole = keyof typeof HONKOKU_FILE_NAMES;
export type HonkokuModelFile = { url: string; sha256: string; bytes: number };
export type HonkokuModelManifest = {
  schemaVersion: 2;
  engineId: 'honkoku-v19';
  modelVersion: 'v19';
  upstreamRepository: typeof HONKOKU_UPSTREAM_REPOSITORY;
  upstreamCommit: typeof HONKOKU_V19_UPSTREAM_COMMIT;
  license: 'CC-BY-4.0' | 'CC-BY-SA-4.0';
  runtime: typeof HONKOKU_RUNTIME;
  files: Record<HonkokuModelRole, HonkokuModelFile>;
};

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid manifest object.');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key))) {
    throw new Error('Unexpected manifest fields.');
  }
  return result;
}

export function requireHttpsUrl(value: string, base?: string): string {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Model URLs require HTTPS without credentials or fragments.');
  }
  return url.href;
}

export function validateHonkokuManifest(value: unknown, manifestUrl: string): HonkokuModelManifest {
  const base = requireHttpsUrl(manifestUrl);
  const data = record(value, ['schemaVersion', 'engineId', 'modelVersion', 'upstreamRepository',
    'upstreamCommit', 'license', 'runtime', 'files']);
  if (data.schemaVersion !== 2 || data.engineId !== 'honkoku-v19' || data.modelVersion !== 'v19'
    || data.upstreamRepository !== HONKOKU_UPSTREAM_REPOSITORY
    || data.upstreamCommit !== HONKOKU_V19_UPSTREAM_COMMIT || !['CC-BY-4.0', 'CC-BY-SA-4.0'].includes(String(data.license))) {
    throw new Error('Unsupported Honkoku model identity or license.');
  }
  const runtime = record(data.runtime, Object.keys(HONKOKU_RUNTIME));
  for (const [key, expected] of Object.entries(HONKOKU_RUNTIME)) {
    if (runtime[key] !== expected) throw new Error('Incompatible Honkoku runtime shape.');
  }
  const entries = record(data.files, Object.keys(HONKOKU_FILE_NAMES));
  const files = {} as HonkokuModelManifest['files'];
  const urls = new Set<string>();
  for (const role of Object.keys(HONKOKU_FILE_NAMES) as HonkokuModelRole[]) {
    const file = record(entries[role], ['url', 'sha256', 'bytes']);
    if (typeof file.url !== 'string' || !file.url.trim()
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
      || typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) {
      throw new Error('Invalid Honkoku model file metadata.');
    }
    const url = requireHttpsUrl(file.url, base);
    if (urls.has(url)) throw new Error('Model roles must use distinct URLs.');
    urls.add(url);
    files[role] = { url, sha256: file.sha256, bytes: file.bytes };
  }
  const manifest: HonkokuModelManifest = {
    schemaVersion: 2, engineId: 'honkoku-v19', modelVersion: 'v19',
    upstreamRepository: HONKOKU_UPSTREAM_REPOSITORY, upstreamCommit: HONKOKU_V19_UPSTREAM_COMMIT,
    license: data.license as HonkokuModelManifest['license'], runtime: { ...HONKOKU_RUNTIME }, files,
  };
  if (!Number.isSafeInteger(totalHonkokuModelBytes(manifest))) throw new Error('Model byte total is too large.');
  return manifest;
}

export function canonicalJson(value: unknown): string {
  function sorted(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sorted);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sorted(child)]));
    return item;
  }
  return JSON.stringify(sorted(value));
}

export async function sha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function honkokuManifestDigest(manifest: HonkokuModelManifest): Promise<string> {
  return sha256(new TextEncoder().encode(canonicalJson(manifest)));
}

export function totalHonkokuModelBytes(manifest: HonkokuModelManifest): number {
  return Object.values(manifest.files).reduce((sum, file) => sum + file.bytes, 0);
}

export async function fetchHonkokuManifest(url: string, signal?: AbortSignal, fetcher: typeof fetch = fetch) {
  signal?.throwIfAborted();
  const requestedUrl = requireHttpsUrl(url);
  const timeout = AbortSignal.timeout(30_000);
  const boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetcher(requestedUrl, {
    signal: boundedSignal, cache: 'no-cache', credentials: 'omit', mode: 'cors', redirect: 'error',
  });
  if (!response.ok) throw new Error(`Honkoku manifest fetch failed: HTTP ${response.status}`);
  // Bound both advertised and actual size. A deployment manifest must be small.
  if (Number(response.headers.get('Content-Length')) > 65536) throw new Error('Manifest is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty manifest response.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) throw new Error('Manifest is too large.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const manifest = validateHonkokuManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), requestedUrl);
  return { manifest, digest: await honkokuManifestDigest(manifest) };
}
