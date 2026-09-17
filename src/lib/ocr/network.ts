export class OcrFailure extends Error {
  readonly kind: "image" | "model" | "worker" | "storage" | "unsupported";
  constructor(message: string, kind: OcrFailure["kind"]) {
    super(message);
    this.name = "OcrFailure";
    this.kind = kind;
  }
}

export function abortCheck(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("OCR cancelled", "AbortError");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    abortCheck(signal);
    const abort = () => { clearTimeout(timer); reject(new DOMException("OCR cancelled", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Initial request plus at most two retries, never retry a cancellation. */
export async function fetchOcrResource(url: string, options: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    abortCheck(signal);
    let response: Response;
    try {
      response = await fetch(url, { ...options, signal: signal ?? options.signal });
    } catch (error) {
      abortCheck(signal);
      if (attempt >= 2) throw new OcrFailure(`Image request failed: ${String(error)}`, "image");
      await delay(500 * 2 ** attempt, signal);
      continue;
    }
    if (response.ok) return response;
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      const header = response.headers.get("Retry-After");
      const seconds = header ? Number(header) : NaN;
      const after = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : 0;
      await response.body?.cancel();
      await delay(Math.min(30_000, Math.max(500 * 2 ** attempt, after || 0)), signal);
      continue;
    }
    throw new OcrFailure(`Image HTTP ${response.status}: ${url}`, "image");
  }
}
