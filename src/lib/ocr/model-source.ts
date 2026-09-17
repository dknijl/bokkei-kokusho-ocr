import { NDL_MODEL_REF, isNdlModelRevision } from "./model-revision.ts";
import { readOcrModelAsset, writeOcrModelAsset } from "./model-cache.ts";
import { abortCheck, OcrFailure } from "./network.ts";

export const NDL_LATEST_REVISION_URL = `https://api.github.com/repos/ndl-lab/ndlkotenocr-lite/commits/${NDL_MODEL_REF}`;
const REVISION_CACHE_KEY = `ndl-ocr:resolved-revision:${NDL_MODEL_REF}`;

/** Resolve the moving branch once before a new run; stored jobs never resolve it again. */
export async function resolveLatestNdlModelRevision(signal?: AbortSignal): Promise<string> {
  abortCheck(signal);
  const cached = await readOcrModelAsset(REVISION_CACHE_KEY);
  abortCheck(signal);
  const saved = cached ? new TextDecoder().decode(cached) : undefined;
  if (isNdlModelRevision(saved)) return saved;
  try {
    const timeout = AbortSignal.timeout(20_000);
    const response = await fetch(NDL_LATEST_REVISION_URL, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      cache: "no-cache", headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: unknown = await response.json();
    const revision = data && typeof data === "object" && "sha" in data ? data.sha : undefined;
    if (!isNdlModelRevision(revision)) throw new Error("Invalid model commit SHA");
    abortCheck(signal);
    await writeOcrModelAsset(REVISION_CACHE_KEY, new TextEncoder().encode(revision).buffer);
    abortCheck(signal);
    return revision;
  } catch (error) {
    abortCheck(signal);
    throw new OcrFailure(`OCR model version could not be resolved: ${String(error)}`, "model");
  }
}
