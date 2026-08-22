import type { NdlOcrResult } from "./ndl-ocr";
import type { ViewerManifest, ViewerPage } from "./iiif";

export function findPageIndexByCanvasId(
  pages: ViewerPage[],
  canvasId: string | undefined,
): number {
  if (!canvasId) return -1;
  return pages.findIndex((item) => item.canvasId === canvasId);
}

function pageIndexFromCanvasNumber(pages: ViewerPage[], canvasNumber: number | undefined): number {
  if (!Number.isSafeInteger(canvasNumber) || (canvasNumber ?? 0) < 1) return -1;
  const index = (canvasNumber ?? 0) - 1;
  return index >= 0 && index < pages.length ? index : -1;
}

export function resolveInitialPageIndex(options: {
  pages: ViewerPage[];
  routeCanvasNumber?: number;
  previousCanvasId?: string;
  storedCanvasId?: string;
}): number {
  const { pages, routeCanvasNumber, previousCanvasId, storedCanvasId } = options;
  if (!pages.length) return 0;

  const routeIndex = pageIndexFromCanvasNumber(pages, routeCanvasNumber);
  if (routeIndex >= 0) return routeIndex;

  const previousIndex = findPageIndexByCanvasId(pages, previousCanvasId);
  if (previousIndex >= 0) return previousIndex;

  const storedIndex = findPageIndexByCanvasId(pages, storedCanvasId);
  if (storedIndex >= 0) return storedIndex;

  return 0;
}

export function applyOcrResult(options: {
  manifest: ViewerManifest;
  targetManifestUrl: string;
  targetCanvasId: string;
  result: NdlOcrResult;
}): { applied: boolean; pageIndex: number } {
  const { manifest, targetManifestUrl, targetCanvasId, result } = options;
  if (manifest.url !== targetManifestUrl) return { applied: false, pageIndex: -1 };

  const pageIndex = findPageIndexByCanvasId(manifest.pages, targetCanvasId);
  if (pageIndex < 0) return { applied: false, pageIndex };

  const targetPage = manifest.pages[pageIndex];
  const coordinateWidth = targetPage.width || result.imageWidth;
  const coordinateHeight = targetPage.height || result.imageHeight;
  const scaleX = coordinateWidth / Math.max(1, result.imageWidth);
  const scaleY = coordinateHeight / Math.max(1, result.imageHeight);

  targetPage.width = coordinateWidth;
  targetPage.height = coordinateHeight;
  targetPage.result = result.lines.map((line) => ({
    ...line,
    region: line.region
      ? {
          x: line.region.x * scaleX,
          y: line.region.y * scaleY,
          width: line.region.width * scaleX,
          height: line.region.height * scaleY,
        }
      : undefined,
  }));
  targetPage.ocrEngine = `NDL古典籍OCR-Lite · ${result.revision.slice(0, 8)}`;
  targetPage.ocrProvider = result.provider;
  manifest.status = "ocrComplete";

  return { applied: true, pageIndex };
}
