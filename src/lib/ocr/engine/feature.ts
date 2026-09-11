const viteEnv = (import.meta as ImportMeta & {
  env?: Record<string, string | undefined>;
}).env ?? {};

export const HONKOKU_V18_FEATURE_ENABLED = viteEnv.VITE_ENABLE_HONKOKU_V18 === "true";
export const HONKOKU_V18_MANIFEST_URL = viteEnv.VITE_HONKOKU_MODEL_MANIFEST_URL?.trim() ?? "";

export function isHonkokuV18Configured(manifestUrl = HONKOKU_V18_MANIFEST_URL): boolean {
  return HONKOKU_V18_FEATURE_ENABLED && Boolean(manifestUrl);
}

export function assertHonkokuV18Configured(manifestUrl = HONKOKU_V18_MANIFEST_URL): void {
  if (!HONKOKU_V18_FEATURE_ENABLED) {
    throw new Error("Honkoku v18 is disabled. Set VITE_ENABLE_HONKOKU_V18=true to enable it.");
  }
  if (!manifestUrl) {
    throw new Error("Honkoku v18 is enabled but VITE_HONKOKU_MODEL_MANIFEST_URL is not configured.");
  }
}
