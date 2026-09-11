export type HonkokuRuntimeProvider = "webgpu" | "wasm";

export async function isWebGpuAvailable(): Promise<boolean> {
  try {
    const gpu = (globalThis.navigator as Navigator & {
      gpu?: { requestAdapter: () => Promise<unknown> };
    } | undefined)?.gpu;
    if (!gpu) return false;
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

export function isMobileRuntime(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 1024;
}

export async function chooseHonkokuRuntime(): Promise<HonkokuRuntimeProvider> {
  if (isMobileRuntime()) return "wasm";
  return await isWebGpuAvailable() ? "webgpu" : "wasm";
}
