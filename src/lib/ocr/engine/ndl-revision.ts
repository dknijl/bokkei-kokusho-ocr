export const NDL_UPSTREAM_REPOSITORY = 'ndl-lab/ndlkotenocr-lite';
export const NDL_REVISION_URL = `https://api.github.com/repos/${NDL_UPSTREAM_REPOSITORY}/commits/master`;

export function requireModelRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error('A model revision must be a full, lowercase Git commit SHA.');
  }
  return value;
}

export async function resolveLatestNdlModelRevision(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  signal?.throwIfAborted();
  const response = await fetcher(NDL_REVISION_URL, { signal, cache: 'no-cache', credentials: 'omit' });
  if (!response.ok) throw new Error(`NDL revision lookup failed: HTTP ${response.status}`);
  const value: unknown = await response.json();
  signal?.throwIfAborted();
  return requireModelRevision(value && typeof value === 'object' && 'sha' in value ? value.sha : undefined);
}

export function ndlModelAssetUrls(revision: string) {
  const root = `https://raw.githubusercontent.com/${NDL_UPSTREAM_REPOSITORY}/${requireModelRevision(revision)}`;
  return {
    detector: `${root}/src/model/rtmdet-s-1280x1280.onnx`,
    recognizer: `${root}/src/model/parseq-ndl-32x384-tiny-10.onnx`,
    charset: `${root}/src/config/NDLmoji.yaml`,
  };
}
