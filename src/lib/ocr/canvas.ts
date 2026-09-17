export type OcrCanvas = HTMLCanvasElement | OffscreenCanvas;

const allocated = new WeakSet<OcrCanvas>();
let live = 0, peak = 0, maxPixels = 0;
export function resetCanvasCounters(): void { peak = live; maxPixels = 0; }
export function canvasCounters() { return { live, peak, maxPixels }; }

/** Pixel buffers are explicitly released after each use, including worker execution. */
export function createOcrCanvas(): OcrCanvas {
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
  allocated.add(canvas); live++; peak = Math.max(peak, live);
  return canvas;
}
export function releaseOcrCanvas(canvas: OcrCanvas | null): void {
  if (!canvas) return;
  maxPixels = Math.max(maxPixels, canvas.width * canvas.height);
  canvas.width = 0; canvas.height = 0;
  if (allocated.delete(canvas)) live--;
}
export const yieldOcr = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
