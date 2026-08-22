function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function withProviderFallback<T>(options: {
  primary: () => Promise<T>;
  fallback: () => Promise<T>;
  signal?: AbortSignal;
  onFallback?: (error: unknown) => void;
}): Promise<T> {
  try {
    return await options.primary();
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw error;
    options.onFallback?.(error);
    return options.fallback();
  }
}
