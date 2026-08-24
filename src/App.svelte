<script lang="ts">
  import { onMount, tick } from "svelte";
  import {
    initialManifest,
    manifestPresets,
    localizedText,
    parseManifest,
    type ViewerManifest,
    type ViewerPage,
  } from "./lib/iiif";
  import {
    buildIiifCropUrl,
    buildKuroNetUrl,
    recognizeWithMetom,
    type CropRegion,
    type MetomPrediction,
  } from "./lib/ocr";
  import {
    recognizePageWithNdlLite,
    type NdlOcrResult,
    type NdlOcrProgress,
  } from "./lib/ndl-ocr";
import {
  DEFAULT_NDL_OCR_OPTIONS,
  recognitionRetryThresholdForProfile,
  type NdlOcrOptions,
  type OcrProfile,
} from "./lib/ocr/profiles";
  import {
    createOcrBenchmarkBaseline,
    createOcrBenchmarkRecord,
    downloadBenchmarkFile,
    parseOcrGroundTruthJson,
    serializeBenchmarkCsv,
    serializeBenchmarkJson,
    serializeOcrBenchmarkBaselineJson,
  } from "./lib/ocr/benchmark";
  import type { OcrPageMetrics } from "./lib/ocr/metrics";
  import { createViewerDebug, type PendingOcrMarker } from "./lib/debug";
  import { findItaijiEntries, itaijiSource, normalizeItaijiText } from "./lib/itaiji";
  import { parseViewerLocation, viewerPathFromManifestUrl } from "./lib/viewer-route";
  import {
    applyOcrResult,
    findPageIndexByCanvasId,
    resolveInitialPageIndex,
  } from "./lib/viewer-state";
  import {
    countLabel,
    isLocale,
    localizeError,
    statusLabel,
    t,
    updateDocumentMetadata,
    LocalizedError,
    type Locale,
  } from "./lib/i18n";

  let manifest: ViewerManifest = $state(initialManifest);
  let locale: Locale = $state("ja");
  let pageIndex = $state(0);
  let selectedCanvasId = $state(initialManifest.pages[0]?.canvasId ?? "");
  let narrowPane: "viewer" | "ocr" = $state("viewer");
  let hasLoadedManifest = false;
  const selectedCanvasStorageKey = "bokkei-selected-canvas";
  const ocrTextSizeStorageKey = "bokkei-ocr-text-size";
  const MIN_OCR_TEXT_SIZE = 14;
  const MAX_OCR_TEXT_SIZE = 28;
  const OCR_TEXT_SIZE_STEP = 1;
  const DEFAULT_OCR_TEXT_SIZE = 18;
  const MIN_ZOOM = 40;
  const MAX_ZOOM = 200;
  const ZOOM_STEP = 10;

  let zoom = $state(82);
  let overlay = $state(false);
  let selectedLine = $state(1);
  let query = $state("");
  let variantBrowseAll = $state(false);
  let variantVisibleLimit = $state(120);
  let viewMode: "original" | "contrast" = $state("original");
  let panelTab: "text" | "variants" | "metom" = $state("text");
  let pickerOpen = $state(false);
  let manifestUrl = $state(initialManifest.url);
  let loadError = $state<unknown>(null);
  let loadingUrl = $state("");
  let metomMode = $state(false);
  let crop = $state<CropRegion | null>(null);
  let cropStart = $state<{ x: number; y: number } | null>(null);
  let metomPredictions = $state<MetomPrediction[]>([]);
  let metomLoading = $state(false);
  let metomError = $state<unknown>(null);
  let fullOcrRunning = $state(false);
  let fullOcrProgress = $state<NdlOcrProgress | null>(null);
  let fullOcrError = $state<unknown>(null);
  let ocrAbortController = $state<AbortController | null>(null);
  let ocrTextExpanded = $state(false);
  let ocrResultFontSize = $state(DEFAULT_OCR_TEXT_SIZE);
  let ocrProfile: OcrProfile = $state("balanced");
  let benchmarkGroundTruthText = $state("");
  let benchmarkGroundTruthError = $state("");
  let benchmarkMetrics = $state<OcrPageMetrics | null>(null);

  let page = $derived(manifest.pages[pageIndex]);
  const viewerDebug = createViewerDebug(() => ({
    manifestUrl: manifest.url,
    pageIndex,
    canvasId: manifest.pages[pageIndex]?.canvasId,
  }));
  let average = $derived(
    page.result.length
      ? Math.round(page.result.reduce((sum, line) => sum + (line.recognitionScore ?? line.detectionScore), 0) / page.result.length * 100)
      : 0,
  );
  let detectionAverage = $derived(
    page.result.length
      ? Math.round(page.result.reduce((sum, line) => sum + line.detectionScore, 0) / page.result.length * 100)
      : 0,
  );
  let ocrRegions = $derived(
    page.width && page.height
      ? page.result.flatMap((line, index) => line.region ? [{ ...line.region, index }] : [])
      : [],
  );
  let kuroNetUrl = $derived(buildKuroNetUrl(manifest.url));
  let metomSupported = $derived(Boolean(page.imageServiceId && page.width && page.height));
  let metomCropUrl = $derived(crop && metomSupported ? buildIiifCropUrl(page, crop) : "");
  let manifestTitle = $derived(localizedText(manifest.titleTranslations, locale) || manifest.title);
  let manifestAttribution = $derived(localizedText(manifest.attributionTranslations, locale) || manifest.attribution);
  let pageLabel = $derived(localizedText(page.labelTranslations, locale) || page.label);
  let selectedOcrText = $derived(page.result[selectedLine]?.text ?? "");
  let variantNeedle = $derived(query.trim() || (variantBrowseAll ? "" : selectedOcrText));
  let variantMatches = $derived(findItaijiEntries(variantNeedle));
  let visibleVariantMatches = $derived(variantMatches.slice(0, variantVisibleLimit));
  let variantScopeLabel = $derived(
    query.trim()
      ? t(locale, "searchScope", { query: query.trim() })
      : variantBrowseAll || !selectedOcrText
        ? t(locale, "allList")
        : t(locale, "selectedOcrLine"),
  );
  let ocrTextStyle = $derived(
    `--ocr-font-size:${ocrResultFontSize}px;--ocr-column-width:${Math.min(78, Math.max(46, Math.round(ocrResultFontSize * 2.6)))}px`,
  );

  function scorePercent(score: number | undefined): string {
    return score === undefined ? "—" : `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
  }

  function lineIsLowConfidence(line: typeof page.result[number]): boolean {
    return line.recognitionScore === undefined
      || line.recognitionScore < recognitionRetryThresholdForProfile(ocrProfile)
      || line.minimumTokenScore !== undefined && line.minimumTokenScore < 0.28
      || line.meanTokenMargin !== undefined && line.meanTokenMargin < 0.35
      || line.endedWithEos === false
      || line.uncertain === true;
  }

  function lineScoreSummary(line: typeof page.result[number]): string {
    return t(locale, "lineScores", {
      recognition: scorePercent(line.recognitionScore),
      detection: scorePercent(line.detectionScore),
    });
  }

  function activeOcrOptions(): NdlOcrOptions {
    return {
      ...DEFAULT_NDL_OCR_OPTIONS,
      profile: ocrProfile,
      enableHighResolutionRetry: ocrProfile !== "fast",
      enableAdaptiveTiling: ocrProfile === "accurate",
      enableDeskewRetry: ocrProfile === "accurate",
      enableLongLineSegmentation: ocrProfile === "accurate",
      maxExtraRecognitions: ocrProfile === "fast" ? 0 : ocrProfile === "accurate" ? 6 : 2,
    };
  }

  function setLocale(nextLocale: Locale) {
    locale = nextLocale;
    try {
      window.localStorage.setItem("bokkei-locale", nextLocale);
    } catch {
      // Storage can be unavailable in private or restricted browsing contexts.
    }
    updateDocumentMetadata(nextLocale);
  }

  function normalizeOcrTextSize(value: number): number {
    if (!Number.isFinite(value)) return DEFAULT_OCR_TEXT_SIZE;
    return Math.min(MAX_OCR_TEXT_SIZE, Math.max(MIN_OCR_TEXT_SIZE, Math.round(value)));
  }

  function setOcrResultFontSize(value: number): void {
    ocrResultFontSize = normalizeOcrTextSize(value);
    try {
      window.localStorage.setItem(ocrTextSizeStorageKey, String(ocrResultFontSize));
    } catch {
      // Text-size preferences are optional when storage is unavailable.
    }
  }

  function adjustOcrResultFontSize(delta: number): void {
    setOcrResultFontSize(ocrResultFontSize + delta);
  }

  function restoreOcrResultFontSize(): void {
    try {
      const stored = Number(window.localStorage.getItem(ocrTextSizeStorageKey));
      if (Number.isFinite(stored)) ocrResultFontSize = normalizeOcrTextSize(stored);
    } catch {
      // Use the default size when persisted preferences cannot be read.
    }
  }

  function pageLabelFor(item: ViewerPage): string {
    return localizedText(item.labelTranslations, locale) || item.label;
  }

  function thumbnailAspectRatio(item: ViewerPage): string | undefined {
    return item.width > 0 && item.height > 0
      ? `${item.width} / ${item.height}`
      : undefined;
  }

  function presetDetail(index: number): string {
    const preset = manifestPresets[index];
    return locale === "en" ? preset.detailEn : preset.detail;
  }

  function presetTag(index: number): string {
    const preset = manifestPresets[index];
    return typeof preset.imageCount === "number" ? countLabel(locale, preset.imageCount, "image") : "IIIF";
  }

  function openingLabel(): string {
    return manifest.viewingDirection === "left-to-right"
      ? t(locale, "openingLeft")
      : t(locale, "openingRight");
  }

  function resetMetom() {
    crop = null;
    cropStart = null;
    metomPredictions = [];
    metomError = null;
  }

  function resetBenchmarkState() {
    benchmarkGroundTruthText = "";
    benchmarkGroundTruthError = "";
    benchmarkMetrics = null;
  }

  function cancelFullOcr() {
    ocrAbortController?.abort();
  }

  function resetFullOcrState() {
    cancelFullOcr();
    ocrAbortController = null;
    fullOcrRunning = false;
    fullOcrProgress = null;
    fullOcrError = null;
  }

  function storedCanvasIdFor(manifestUrl: string): string | undefined {
    try {
      const raw = window.sessionStorage.getItem(selectedCanvasStorageKey);
      if (!raw) return undefined;
      const stored = JSON.parse(raw) as { manifestUrl?: unknown; canvasId?: unknown };
      return stored.manifestUrl === manifestUrl && typeof stored.canvasId === "string"
        ? stored.canvasId
        : undefined;
    } catch {
      return undefined;
    }
  }

  function storeCanvasId(manifestUrl: string, canvasId: string): void {
    try {
      window.sessionStorage.setItem(
        selectedCanvasStorageKey,
        JSON.stringify({ manifestUrl, canvasId }),
      );
    } catch {
      // Page selection should continue when storage is unavailable.
    }
  }

  function revealActiveThumbnail(index: number): void {
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(
        `.thumb[data-page-index="${index}"]`,
      );
      target?.scrollIntoView({
        block: "nearest",
        inline: "center",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    });
  }

  function preserveDebugQuery(path: string): string {
    const nextUrl = new URL(path, window.location.origin);
    const debugQuery = new URLSearchParams(window.location.search).get("debug");
    if (debugQuery) nextUrl.searchParams.set("debug", debugQuery);
    nextUrl.hash = window.location.hash;
    return `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
  }

  function syncManifestPath(nextManifestUrl: string, nextPageIndex: number): void {
    const nextPath = preserveDebugQuery(
      viewerPathFromManifestUrl(nextManifestUrl, nextPageIndex + 1),
    );
    const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (currentPath !== nextPath) window.history.pushState(null, "", nextPath);
  }

  function syncCanvasPath(index: number): void {
    const nextPath = preserveDebugQuery(viewerPathFromManifestUrl(manifest.url, index + 1));
    const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (currentPath !== nextPath) window.history.replaceState(null, "", nextPath);
  }

  function setSelectedPage(index: number, syncHistory = true): void {
    const nextIndex = Math.min(manifest.pages.length - 1, Math.max(0, index));
    const nextPage = manifest.pages[nextIndex];
    if (!nextPage) return;

    pageIndex = nextIndex;
    selectedCanvasId = nextPage.canvasId;
    storeCanvasId(manifest.url, nextPage.canvasId);
    narrowPane = "viewer";
    if (syncHistory) syncCanvasPath(nextIndex);
    revealActiveThumbnail(nextIndex);
  }

  function selectPage(index: number) {
    resetFullOcrState();
    resetBenchmarkState();
    setSelectedPage(index);
    selectedLine = 0;
    overlay = false;
    variantBrowseAll = false;
    variantVisibleLimit = 120;
    resetMetom();
    viewerDebug.log("page-selected", { reason: "thumbnail" });
  }

  function movePage(delta: number) {
    const nextIndex = Math.min(manifest.pages.length - 1, Math.max(0, pageIndex + delta));
    if (nextIndex === pageIndex) return;
    resetFullOcrState();
    resetBenchmarkState();
    setSelectedPage(nextIndex);
    selectedLine = 0;
    overlay = false;
    variantBrowseAll = false;
    variantVisibleLimit = 120;
    resetMetom();
    viewerDebug.log("page-moved", { delta });
  }

  function adjustZoom(delta: number) {
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom + delta));
  }

  function scrollToOcrLine(index: number) {
    void tick().then(() => {
      document.querySelectorAll<HTMLButtonElement>(`.vertical-text button[data-line-index="${index}"]`)
        .forEach((line) => line.scrollIntoView({ block: "nearest", inline: "nearest" }));
    });
  }

  function selectOcrLine(index: number) {
    selectedLine = index;
    variantBrowseAll = false;
    variantVisibleLimit = 120;
    scrollToOcrLine(index);
  }

  function restoreCanvas(canvasNumber?: number): void {
    resetFullOcrState();
    resetBenchmarkState();
    setSelectedPage(resolveInitialPageIndex({
      pages: manifest.pages,
      routeCanvasNumber: canvasNumber,
    }), false);
    selectedLine = 0;
    overlay = false;
    variantBrowseAll = false;
    variantVisibleLimit = 120;
    resetMetom();
    viewerDebug.log("page-selected", { reason: "history" });
  }

  function loadManifestFromLocation(forceLoad = false) {
    const route = parseViewerLocation(window.location);
    if (route.isRoot) {
      if (forceLoad) void loadManifest(initialManifest.url, false, true, route.canvasNumber);
      return;
    }

    if (!route.manifestUrl) {
      manifestUrl = initialManifest.url;
      loadError = new LocalizedError("errorInvalidRoute");
      pickerOpen = true;
      return;
    }

    if (!forceLoad && route.manifestUrl === manifest.url) {
      restoreCanvas(route.canvasNumber);
      return;
    }

    void loadManifest(route.manifestUrl, false, true, route.canvasNumber);
  }

  function handlePopState() {
    viewerDebug.log("popstate");
    loadManifestFromLocation();
  }

  async function loadManifest(
    urlValue: string,
    syncRoute = true,
    revealError = false,
    routeCanvasNumber?: number,
  ) {
    const normalized = urlValue.trim();
    const previousManifestUrl = manifest.url;
    const previousCanvasId = hasLoadedManifest
      ? manifest.pages[pageIndex]?.canvasId ?? selectedCanvasId
      : undefined;
    loadError = null;
    resetFullOcrState();
    manifestUrl = normalized;
    viewerDebug.log("manifest-load-start", { url: normalized });

    try {
      const parsedUrl = new URL(normalized);
      if (parsedUrl.protocol !== "https:") throw new LocalizedError("errorHttpsManifest");

      loadingUrl = normalized;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 15000);
      let response: Response;
      try {
        response = await fetch(normalized, { signal: controller.signal, cache: "no-store" });
      } finally {
        window.clearTimeout(timeout);
      }
      if (!response.ok) throw new LocalizedError("errorManifestHttp", { status: response.status });

      const raw = (await response.json()) as Record<string, unknown>;
      const nextManifest = parseManifest(raw, normalized, locale);
      const sameManifest = nextManifest.url === previousManifestUrl;
      const restoredIndex = resolveInitialPageIndex({
        pages: nextManifest.pages,
        routeCanvasNumber,
        previousCanvasId: sameManifest ? previousCanvasId : undefined,
        storedCanvasId: storedCanvasIdFor(nextManifest.url),
      });
      manifest = nextManifest;
      manifestUrl = nextManifest.url;
      pageIndex = restoredIndex;
      selectedCanvasId = nextManifest.pages[restoredIndex]?.canvasId ?? "";
      hasLoadedManifest = true;
      if (selectedCanvasId) storeCanvasId(nextManifest.url, selectedCanvasId);
      selectedLine = 0;
      resetBenchmarkState();
      query = "";
      overlay = false;
      variantBrowseAll = false;
      variantVisibleLimit = 120;
      narrowPane = "viewer";
      pickerOpen = false;
      resetMetom();
      if (syncRoute) syncManifestPath(nextManifest.url, restoredIndex);
      revealActiveThumbnail(restoredIndex);
      viewerDebug.log("manifest-load-complete", {
        url: nextManifest.url,
        restoredCanvasId: selectedCanvasId,
        restoredPageIndex: restoredIndex,
      });
    } catch (error) {
      loadError = error instanceof Error && error.name === "AbortError"
        ? new LocalizedError("errorManifestTimeout")
        : error instanceof Error
          ? error
          : new LocalizedError("errorManifestGeneric");
      if (revealError) pickerOpen = true;
      viewerDebug.log("manifest-load-complete", {
        url: normalized,
        success: false,
        error: loadError instanceof Error ? loadError.message : String(loadError),
      });
    } finally {
      if (loadingUrl === normalized) loadingUrl = "";
    }
  }

  onMount(() => {
    restoreOcrResultFontSize();
    try {
      const storedLocale = window.localStorage.getItem("bokkei-locale");
      if (isLocale(storedLocale)) locale = storedLocale;
    } catch {
      // Use Japanese when persisted preferences cannot be read.
    }
    updateDocumentMetadata(locale);
    const pendingOcr = viewerDebug.readPendingOcr();
    viewerDebug.log("app-mounted", pendingOcr
      ? {
          pendingOcr,
          reloadedDuringOcr: pendingOcr.instanceId !== viewerDebug.instanceId,
        }
      : undefined);

    const handlePageShow = () => viewerDebug.log("pageshow");
    const handlePageHide = (event: PageTransitionEvent) => viewerDebug.log("pagehide", { persisted: event.persisted });
    const handleBeforeUnload = () => viewerDebug.log("beforeunload");
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => viewerDebug.log(
      "unhandledrejection",
      { reason: event.reason instanceof Error ? event.reason.message : String(event.reason) },
    );
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    loadManifestFromLocation(true);

    return () => {
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  });

  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      if (ocrTextExpanded) {
        ocrTextExpanded = false;
        return;
      }
      pickerOpen = false;
      cropStart = null;
    }
  }

  function openOcrTextExpanded() {
    ocrTextExpanded = true;
  }

  function closeOcrTextExpanded() {
    ocrTextExpanded = false;
  }

  function relativePoint(event: PointerEvent) {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    return {
      x: Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)),
      y: Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100)),
    };
  }

  function startCrop(event: PointerEvent) {
    if (!metomMode) return;
    if (!metomSupported) {
      metomError = new LocalizedError("errorMetomUnsupported");
      return;
    }
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const point = relativePoint(event);
    cropStart = point;
    crop = { x: point.x, y: point.y, width: 0, height: 0 };
    metomPredictions = [];
    metomError = null;
  }

  function updateCrop(event: PointerEvent) {
    if (!metomMode || !cropStart) return;
    const point = relativePoint(event);
    crop = {
      x: Math.min(cropStart.x, point.x),
      y: Math.min(cropStart.y, point.y),
      width: Math.abs(point.x - cropStart.x),
      height: Math.abs(point.y - cropStart.y),
    };
  }

  function finishCrop(event: PointerEvent) {
    if (!cropStart) return;
    updateCrop(event);
    cropStart = null;
    if (crop && (crop.width < 0.4 || crop.height < 0.4)) crop = null;
  }

  function openMetomPanel() {
    panelTab = "metom";
    metomMode = true;
    overlay = false;
  }

  async function runMetom() {
    if (!metomSupported) {
      metomError = new LocalizedError("errorMetomUnsupported");
      return;
    }
    if (!crop) {
      metomError = new LocalizedError("errorMetomSelect");
      return;
    }

    metomLoading = true;
    metomError = null;
    metomPredictions = [];
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);

    try {
      metomPredictions = await recognizeWithMetom(metomCropUrl, controller.signal);
      if (!metomPredictions.length) throw new LocalizedError("errorMetomEmpty");
    } catch (error) {
      metomError = error instanceof Error && error.name === "AbortError"
        ? new LocalizedError("errorMetomTimeout")
        : error instanceof Error
          ? error
          : new LocalizedError("errorMetomGeneric");
    } finally {
      window.clearTimeout(timeout);
      metomLoading = false;
    }
  }

  async function runFullPageOcr() {
    if (fullOcrRunning) return;

    const targetPage = page;
    const targetManifestUrl = manifest.url;
    const targetCanvasId = targetPage.canvasId;
    const ocrOptions = activeOcrOptions();
    const startedAt = Date.now();
    const controller = new AbortController();
    let pendingOcr: PendingOcrMarker | null = null;
    ocrAbortController = controller;
    fullOcrRunning = true;
    fullOcrError = null;
    panelTab = "text";
    metomMode = false;
    overlay = false;
    fullOcrProgress = { stage: "image", percent: 1, messageKey: "progressStarting" };
    pendingOcr = viewerDebug.setPendingOcr({
      manifestUrl: targetManifestUrl,
      canvasId: targetCanvasId,
      pageIndex,
      startedAt,
    });
    viewerDebug.log("ocr-start", { canvasId: targetCanvasId });
    try {
      const applyResult = (result: NdlOcrResult): boolean => {
        if (controller.signal.aborted) {
          viewerDebug.log("ocr-cancelled", { canvasId: targetCanvasId, reason: "aborted" });
          return false;
        }
        const applied = applyOcrResult({
          manifest,
          targetManifestUrl,
          targetCanvasId,
          result,
        });
        if (!applied.applied) {
          viewerDebug.log("ocr-cancelled", {
            canvasId: targetCanvasId,
            reason: manifest.url === targetManifestUrl ? "canvas-not-found" : "manifest-changed",
          });
          return false;
        }

        if (manifest.pages[pageIndex]?.canvasId === targetCanvasId) {
          selectedLine = 0;
          overlay = true;
          variantBrowseAll = false;
          variantVisibleLimit = 120;
          scrollToOcrLine(0);
        }
        viewerDebug.log("ocr-success", {
          canvasId: targetCanvasId,
          lineCount: result.lines.length,
          appliedPageIndex: applied.pageIndex,
          source: "model",
        });
        return true;
      };

      const result = await recognizePageWithNdlLite(
        targetPage,
        ocrOptions,
        (progress) => {
          if (ocrAbortController === controller) {
            fullOcrProgress = progress;
            viewerDebug.log("ocr-progress", {
              canvasId: targetCanvasId,
              stage: progress.stage,
              percent: progress.percent,
              completed: progress.completed,
              total: progress.total,
            });
          }
        },
        controller.signal,
      );
      if (controller.signal.aborted) {
        viewerDebug.log("ocr-cancelled", { canvasId: targetCanvasId, reason: "aborted" });
        return;
      }

      applyResult(result);
    } catch (error) {
      const isCurrentOcr = ocrAbortController === controller;
      if (isCurrentOcr) fullOcrError = error instanceof Error && error.name === "AbortError"
        ? new LocalizedError("errorOcrCancelled")
        : error instanceof Error
          ? error
          : new LocalizedError("errorOcrGeneric");
      viewerDebug.log(
        error instanceof Error && error.name === "AbortError" ? "ocr-cancelled" : "ocr-error",
        {
          canvasId: targetCanvasId,
          error: error instanceof Error ? error.message : String(error),
          current: isCurrentOcr,
        },
      );
    } finally {
      viewerDebug.clearPendingOcr(pendingOcr);
      if (ocrAbortController === controller) {
        fullOcrRunning = false;
        ocrAbortController = null;
      }
    }
  }

  function exportBenchmark(format: "json" | "csv" | "baseline") {
    if (!page.result.length) return;
    let groundTruth;
    if (benchmarkGroundTruthText.trim()) {
      try {
        groundTruth = parseOcrGroundTruthJson(benchmarkGroundTruthText);
        benchmarkGroundTruthError = "";
      } catch (error) {
        benchmarkGroundTruthError = error instanceof Error ? error.message : String(error);
        return;
      }
    }
    const record = createOcrBenchmarkRecord({
      page,
      manifestUrl: manifest.url,
      modelRevision: page.ocrModelRevision,
      provider: page.ocrProvider,
      profile: page.ocrProfile,
      ocrOptions: page.ocrOptions,
      groundTruth,
      normalizedText: normalizeItaijiText,
    });
    const suffix = `${manifest.recordId}-${pageIndex + 1}`;
    if (format === "baseline") {
      const baseline = createOcrBenchmarkBaseline([record]);
      downloadBenchmarkFile(`ocr-baseline-${suffix}.json`, serializeOcrBenchmarkBaselineJson(baseline), "application/json");
    } else if (format === "json") {
      downloadBenchmarkFile(`ocr-benchmark-${suffix}.json`, serializeBenchmarkJson(record), "application/json");
    } else {
      downloadBenchmarkFile(`ocr-benchmark-${suffix}.csv`, serializeBenchmarkCsv(record), "text/csv;charset=utf-8");
    }
    viewerDebug.log("ocr-benchmark-export", { format, canvasId: page.canvasId });
  }

  function evaluateBenchmark() {
    benchmarkGroundTruthError = "";
    benchmarkMetrics = null;
    if (!benchmarkGroundTruthText.trim()) {
      benchmarkGroundTruthError = t(locale, "benchmarkGroundTruthRequired");
      return;
    }
    try {
      const groundTruth = parseOcrGroundTruthJson(benchmarkGroundTruthText);
      const record = createOcrBenchmarkRecord({
        page,
        manifestUrl: manifest.url,
        modelRevision: page.ocrModelRevision,
        provider: page.ocrProvider,
        profile: page.ocrProfile,
        ocrOptions: page.ocrOptions,
        groundTruth,
        normalizedText: normalizeItaijiText,
      });
      benchmarkMetrics = record.metrics ?? null;
      viewerDebug.log("ocr-benchmark-evaluated", {
        canvasId: page.canvasId,
        cer: benchmarkMetrics?.raw.cer,
        detectionF1: benchmarkMetrics?.detection.f1,
      });
    } catch (error) {
      benchmarkGroundTruthError = error instanceof Error ? error.message : String(error);
    }
  }

  function metricPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} onpopstate={handlePopState} />

{#snippet ocrFontSizeControl(inputId: string)}
  <div class="ocr-font-size-control" role="group" aria-label={t(locale, "ocrTextSize")}>
    <span class="ocr-font-size-label" aria-hidden="true">A</span>
    <button
      type="button"
      onclick={() => adjustOcrResultFontSize(-OCR_TEXT_SIZE_STEP)}
      disabled={ocrResultFontSize <= MIN_OCR_TEXT_SIZE}
      aria-label={t(locale, "ocrTextSizeDecrease")}
    >−</button>
    <input
      id={inputId}
      name="ocr-text-size"
      type="range"
      min={MIN_OCR_TEXT_SIZE}
      max={MAX_OCR_TEXT_SIZE}
      step={OCR_TEXT_SIZE_STEP}
      value={ocrResultFontSize}
      aria-label={t(locale, "ocrTextSize")}
      aria-valuetext={t(locale, "ocrTextSizeValue", { size: ocrResultFontSize })}
      oninput={(event) => setOcrResultFontSize(Number((event.currentTarget as HTMLInputElement).value))}
    />
    <button
      type="button"
      onclick={() => adjustOcrResultFontSize(OCR_TEXT_SIZE_STEP)}
      disabled={ocrResultFontSize >= MAX_OCR_TEXT_SIZE}
      aria-label={t(locale, "ocrTextSizeIncrease")}
    >＋</button>
    <output for={inputId}>{ocrResultFontSize}px</output>
  </div>
{/snippet}

{#snippet ocrResultList()}
  {#if page.result.length}
    {#each page.result as line, index (`${line.text}-${index}`)}
      {@const scoreSummary = lineScoreSummary(line)}
      {@const lowConfidence = lineIsLowConfidence(line)}
      <button
        type="button"
        class:active={selectedLine === index}
        class:match={Boolean(query && line.text.includes(query))}
        data-line-index={index}
        onclick={() => selectOcrLine(index)}
      >
        <span>{line.text || t(locale, "unreadable")}</span>
        <small class:low={lowConfidence} title={scoreSummary} aria-label={scoreSummary}>
          <span>{t(locale, "recognitionShort")} {scorePercent(line.recognitionScore)}</span>
          <span>{t(locale, "detectionShort")} {scorePercent(line.detectionScore)}</span>
        </small>
      </button>
    {/each}
  {:else}
    <div class="ocr-empty"><strong>{t(locale, "ocrNotRun")}</strong><span>{t(locale, "runOcrInstruction")}</span></div>
  {/if}
{/snippet}

<main class="app-shell">
  <header class="topbar">
    <a class="brand" href="#viewer" aria-label={t(locale, "homeAria")}>
      <span class="brand-mark">墨</span>
      <span><strong>墨景</strong><small>BOKKEI / KOTEN OCR SERVICE</small></span>
    </a>

    <div class="document-title">
      <span class="eyebrow">IIIF · {manifest.recordId === "EXTERNAL" ? t(locale, "externalMaterial") : t(locale, "bibliographicId", { id: manifest.recordId })}</span>
      <strong title={manifestTitle}>{manifestTitle}</strong>
      <span class="status"><i></i> {statusLabel(locale, manifest.status)}</span>
    </div>

    <div class="top-actions">
      <div class="language-switch" role="group" aria-label={t(locale, "languageSelector")}>
        <button type="button" class:active={locale === "ja"} onclick={() => setLocale("ja")} aria-pressed={locale === "ja"}>{t(locale, "japanese")}</button>
        <button type="button" class:active={locale === "en"} onclick={() => setLocale("en")} aria-pressed={locale === "en"}>EN</button>
      </div>
      <button type="button" class="manifest-button" onclick={() => (pickerOpen = true)}><span>{t(locale, "material")}</span> {t(locale, "chooseManifest")}</button>
      <span class="ocr-backend-state"><i></i> {t(locale, "ocrBackend")}</span>
    </div>
  </header>

  <section class:show-narrow-ocr={narrowPane === "ocr"} class="workspace" id="viewer">
    <aside class="page-rail" aria-label={t(locale, "pageList")}>
      <div class="rail-count">{String(pageIndex + 1).padStart(2, "0")} / {String(manifest.pages.length).padStart(2, "0")}</div>
      {#each manifest.pages as item, index (`${item.canvasId}-${index}`)}
        <button type="button" data-page-index={index} class:active={pageIndex === index} class="thumb" style:--thumb-aspect-ratio={thumbnailAspectRatio(item)} onclick={() => selectPage(index)} aria-label={t(locale, "pageNumber", { number: index + 1, label: pageLabelFor(item) })}>
          <img src={item.thumbnail} alt="" loading="lazy" decoding="async" />
          <span>{index + 1}</span>
        </button>
      {/each}
      <button type="button" class="rail-add" onclick={() => (pickerOpen = true)}><b>＋</b><span>Manifest</span></button>
    </aside>

    <nav class="narrow-pane-switcher" aria-label={t(locale, "mobilePaneSelector")}>
      <button
        type="button"
        class:active={narrowPane === "viewer"}
        aria-pressed={narrowPane === "viewer"}
        onclick={() => (narrowPane = "viewer")}
      >
        {t(locale, "viewer")}
      </button>
      <button
        type="button"
        class:active={narrowPane === "ocr"}
        aria-pressed={narrowPane === "ocr"}
        onclick={() => (narrowPane = "ocr")}
      >
        {t(locale, "recognitionResult")}
        {#if page.result.length}<span>{page.result.length}</span>{/if}
      </button>
    </nav>

    <section class="image-stage" aria-label={t(locale, "viewer")}>
      <div class="viewer-toolbar">
        <div class="segmented" aria-label={t(locale, "displayMethod")}>
          <button type="button" class:active={viewMode === "original"} onclick={() => (viewMode = "original")}>{t(locale, "originalImage")}</button>
          <button type="button" class:active={viewMode === "contrast"} onclick={() => (viewMode = "contrast")}>{t(locale, "inkEnhanced")}</button>
        </div>
        <label class:disabled={!ocrRegions.length} class="overlay-toggle">
          <input id="ocr-overlay" name="ocr-overlay" type="checkbox" bind:checked={overlay} disabled={!ocrRegions.length} />
          <span></span>{ocrRegions.length ? t(locale, "ocrRegions", { count: ocrRegions.length }) : t(locale, "noOcrCoordinates")}
        </label>
        <button type="button" class:active={metomMode} class="crop-mode-button" onclick={openMetomPanel}>{t(locale, "selectCharacter")}</button>
        <label class="ocr-profile-control" for="ocr-profile">
          <span>{t(locale, "ocrProfile")}</span>
          <select id="ocr-profile" bind:value={ocrProfile} disabled={fullOcrRunning}>
            <option value="fast">{t(locale, "ocrProfileFast")}</option>
            <option value="balanced">{t(locale, "ocrProfileBalanced")}</option>
            <option value="accurate">{t(locale, "ocrProfileAccurate")}</option>
          </select>
        </label>
        <section class:running={fullOcrRunning} class="toolbar-ocr-action" aria-label={t(locale, "autoOcr")}>
          {#if fullOcrRunning}
            <button
              type="button"
              class="toolbar-ocr-button cancel-ocr is-loading"
              onclick={cancelFullOcr}
              title={fullOcrProgress ? t(locale, fullOcrProgress.messageKey, fullOcrProgress.params) : t(locale, "cancel")}
              aria-label={fullOcrProgress ? `${t(locale, "cancel")}: ${t(locale, fullOcrProgress.messageKey, fullOcrProgress.params)} ${fullOcrProgress.percent}%` : t(locale, "cancel")}
            >
              {#if fullOcrProgress}<span class="toolbar-ocr-fill" style={`width:${fullOcrProgress.percent}%`}></span>{/if}
              <span class="toolbar-ocr-label"><span>{t(locale, "cancel")}</span>{#if fullOcrProgress}<b>{fullOcrProgress.percent}%</b>{/if}</span>
            </button>
          {:else}
            <button type="button" class="toolbar-ocr-button run-full-ocr" onclick={() => void runFullPageOcr()}>{page.ocrEngine ? t(locale, "rerunPage") : t(locale, "runPage")}</button>
          {/if}
        </section>
        <div class="zoom-control">
          <button type="button" onclick={() => adjustZoom(-ZOOM_STEP)} disabled={zoom <= MIN_ZOOM} aria-label={t(locale, "zoomOut")}>−</button>
          <input id="viewer-zoom" name="zoom" aria-label={t(locale, "zoomLevel")} type="range" min={MIN_ZOOM} max={MAX_ZOOM} step="1" bind:value={zoom} />
          <button type="button" onclick={() => adjustZoom(ZOOM_STEP)} disabled={zoom >= MAX_ZOOM} aria-label={t(locale, "zoomIn")}>＋</button>
          <output for="viewer-zoom">{zoom}%</output>
        </div>
      </div>

      <div class="canvas-wrap">
        <div class:contrast={viewMode === "contrast"} class="manuscript" style:width={`${zoom}%`}>
          {#key page.image}
            <img src={page.image} alt={t(locale, "imageAlt", { title: manifestTitle, label: pageLabel })} />
          {/key}
          {#if overlay && ocrRegions.length}
            <div class="ocr-boxes" aria-label={t(locale, "detectedRegions")}>
              {#each ocrRegions as region (region.index)}
                <button
                  type="button"
                  class:active={selectedLine === region.index}
                  class="ocr-box"
                  style={`left:${(region.x / page.width) * 100}%;top:${(region.y / page.height) * 100}%;width:${(region.width / page.width) * 100}%;height:${(region.height / page.height) * 100}%`}
                  onclick={() => selectOcrLine(region.index)}
                  aria-label={t(locale, "detectedRegion", { number: region.index + 1 })}
                ><span>{region.index + 1}</span></button>
              {/each}
            </div>
          {/if}
          <button
            type="button"
            class:enabled={metomMode}
            class="metom-crop-layer"
            aria-label={t(locale, "metomSelection")}
            tabindex={metomMode ? 0 : -1}
            onpointerdown={startCrop}
            onpointermove={updateCrop}
            onpointerup={finishCrop}
            onpointercancel={finishCrop}
          >
            {#if crop}
              <span
                class="metom-selection"
                style={`left:${crop.x}%;top:${crop.y}%;width:${crop.width}%;height:${crop.height}%`}
              ><b>Metom</b></span>
            {/if}
          </button>
        </div>
        <div class="canvas-meta">
          <span>{t(locale, "canvas", { number: pageIndex + 1 })}</span>
          <span>{page.width && page.height ? t(locale, "dimensions", { width: page.width, height: page.height }) : t(locale, "noDimensions")}</span>
          <span>{openingLabel()}</span>
        </div>
      </div>

      <div class="page-controls">
        <button type="button" onclick={() => movePage(-1)} disabled={pageIndex === 0}>{t(locale, "previous")}</button>
        <span><strong>{pageIndex + 1}</strong> / {manifest.pages.length}</span>
        <button type="button" onclick={() => movePage(1)} disabled={pageIndex === manifest.pages.length - 1}>{t(locale, "next")}</button>
      </div>
    </section>

    <aside class="text-panel">
      <div class="panel-head">
        <div><span class="eyebrow">{t(locale, "recognitionResult")}</span><h1>{t(locale, "ocrHeading")}</h1></div>
        <div class="score-summary">
          <div class="confidence-ring" title={t(locale, "recognitionScore")} style={`--score: ${average * 3.6}deg`}><strong>{average}</strong><small>%</small></div>
          <small>{t(locale, "detectionScore")} {detectionAverage}%</small>
        </div>
      </div>

      <label class="search-field" for="recognition-search"><span>⌕</span><input id="recognition-search" name="query" type="search" placeholder={panelTab === "variants" ? t(locale, "searchVariants") : t(locale, "searchRecognition")} bind:value={query} /><kbd>⌘ K</kbd></label>

      {#if fullOcrError}<div class="full-ocr-error panel-ocr-error" role="alert">{localizeError(fullOcrError, locale, "errorOcrGeneric")}</div>{/if}

      <div class="panel-tabs three" role="tablist">
        <button type="button" class:active={panelTab === "text"} onclick={() => { panelTab = "text"; metomMode = false; }} role="tab" aria-selected={panelTab === "text"}>{t(locale, "transcription")}</button>
        <button type="button" class:active={panelTab === "variants"} onclick={() => { panelTab = "variants"; metomMode = false; }} role="tab" aria-selected={panelTab === "variants"}>{t(locale, "variants")} <span>{itaijiSource.pairCount}</span></button>
        <button type="button" class:active={panelTab === "metom"} onclick={openMetomPanel} role="tab" aria-selected={panelTab === "metom"}>{t(locale, "singleCharacterOcr")}</button>
      </div>

      {#if panelTab === "text"}
        <div class="transcription" aria-label={t(locale, "transcriptionResult")}>
          <div class="reading-order"><span>{t(locale, "readingOrder")}</span><span>{ocrRegions.length ? t(locale, "canvasCoordinates") : t(locale, "noCoordinateData")}</span></div>
          {@render ocrFontSizeControl("ocr-font-size")}
          <div class="vertical-text" style={ocrTextStyle} aria-hidden={ocrTextExpanded ? "true" : undefined}>
            {#if page.result.length}
              <button
                type="button"
                class="ocr-expand-button"
                onclick={openOcrTextExpanded}
                aria-label={t(locale, "expandOcrText")}
                title={t(locale, "expandOcrText")}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" /></svg>
              </button>
            {/if}
            {#if !ocrTextExpanded}{@render ocrResultList()}{/if}
          </div>
          <p class="demo-note">{page.ocrEngine ? t(locale, "ocrConfidenceNote", { engine: page.ocrEngine, provider: page.ocrProvider ?? "" }) : t(locale, "ocrDeviceDescription")}</p>
          {#if page.result.length && viewerDebug.enabled}
            <div class="benchmark-export" aria-label={t(locale, "benchmarkExport")}>
              <span>{t(locale, "benchmarkExport")}</span>
              <button type="button" onclick={() => exportBenchmark("json")}>{t(locale, "exportJson")}</button>
              <button type="button" onclick={() => exportBenchmark("csv")}>{t(locale, "exportCsv")}</button>
              <button type="button" onclick={() => exportBenchmark("baseline")}>{t(locale, "exportBaseline")}</button>
            </div>
            <label class="benchmark-ground-truth" for="benchmark-ground-truth">{t(locale, "benchmarkGroundTruth")}
              <textarea id="benchmark-ground-truth" bind:value={benchmarkGroundTruthText} rows="3" spellcheck="false" placeholder="Paste ground-truth JSON"></textarea>
              <button type="button" onclick={evaluateBenchmark}>{t(locale, "benchmarkEvaluate")}</button>
            </label>
            {#if benchmarkGroundTruthError}<div class="benchmark-error" role="alert">{benchmarkGroundTruthError}</div>{/if}
            {#if benchmarkMetrics}
              <div class="benchmark-metrics" aria-label={t(locale, "benchmarkMetrics")}>
                <span>{t(locale, "benchmarkMetrics")}</span>
                <b>{t(locale, "benchmarkCer")} {metricPercent(benchmarkMetrics.raw.cer)}</b>
                {#if benchmarkMetrics.normalized}<b>{t(locale, "benchmarkNormalizedCer")} {metricPercent(benchmarkMetrics.normalized.cer)}</b>{/if}
                <b>{t(locale, "benchmarkExact")} {metricPercent(benchmarkMetrics.raw.exactLineRate)}</b>
                <b>{t(locale, "benchmarkRecall")} {metricPercent(benchmarkMetrics.detection.recall)}</b>
                <b>{t(locale, "benchmarkF1")} {metricPercent(benchmarkMetrics.detection.f1)}</b>
              </div>
            {/if}
          {/if}
        </div>
      {:else if panelTab === "variants"}
        <section class="variant-list" aria-label={t(locale, "variantPanel")}>
          <header class="variant-summary">
            <div><span>{variantScopeLabel}</span><strong>{variantMatches.length}<small> / {countLabel(locale, itaijiSource.groupCount, "group")}</small></strong></div>
            {#if selectedOcrText && !query.trim()}
              <button type="button" onclick={() => { variantBrowseAll = !variantBrowseAll; variantVisibleLimit = 120; }}>
                {variantBrowseAll ? t(locale, "selectedLineOnly") : t(locale, "allList")}
              </button>
            {/if}
          </header>
          <div class="variant-source">
            <span>{t(locale, "variantSource", { count: itaijiSource.pairCount })}</span>
            <span><a href={itaijiSource.repository} target="_blank" rel="noreferrer">{t(locale, "github")}</a><a href="/licenses/kokusho-itaiji-search.txt" target="_blank">{t(locale, "mit")}</a></span>
          </div>
          {#if visibleVariantMatches.length}
            <div class="variant-entries">
              {#each visibleVariantMatches as entry (entry.normalized)}
                <article class="variant-entry">
                  <div class="variant-glyphs">
                    {#each entry.variants as variant (variant)}<span>{variant}</span>{/each}
                  </div>
                  <b aria-hidden="true">→</b>
                  <strong>{entry.normalized}</strong>
                </article>
              {/each}
            </div>
            {#if visibleVariantMatches.length < variantMatches.length}
              <button type="button" class="variant-more" onclick={() => (variantVisibleLimit += 120)}>
                {t(locale, "showMore", { count: variantMatches.length - visibleVariantMatches.length })}
              </button>
            {/if}
          {:else}
            <div class="variant-empty"><strong>{t(locale, "noVariants")}</strong><span>{t(locale, "noVariantsDetail")}</span></div>
          {/if}
        </section>
      {:else}
        <div class="metom-panel">
          <div class="service-heading">
            <div><span>CODH / SAKANA AI</span><strong>{t(locale, "metomService")}</strong></div>
            <span class="live-badge">{t(locale, "publicApi")}</span>
          </div>
          <p>{t(locale, "metomInstructions")}</p>
          <p class="metom-attribution">{t(locale, "metomAttribution")} <a href="https://codh.rois.ac.jp/char-shape/app/metom/" target="_blank" rel="noreferrer">{t(locale, "metomLink")}</a></p>
          {#if crop}
            <div class="crop-preview"><img src={metomCropUrl} alt={t(locale, "metomCropAlt")} /><code>{Math.round(crop.width)}% × {Math.round(crop.height)}%</code></div>
          {:else}
            <button type="button" class="select-character" onclick={() => (metomMode = true)}>{t(locale, "selectCharacterFromImage")}</button>
          {/if}
          <button type="button" class="run-metom" onclick={() => void runMetom()} disabled={!crop || metomLoading}>
            {metomLoading ? t(locale, "metomRecognizing") : t(locale, "recognizeCharacter")}
          </button>
          {#if metomError}<div class="metom-error" role="alert">{localizeError(metomError, locale, "errorMetomGeneric")}</div>{/if}
          {#if metomPredictions.length}
            <ol class="metom-results">
              {#each metomPredictions as prediction, index (`${prediction.character}-${index}`)}
                <li><span>{index + 1}</span><strong>{prediction.character}</strong><meter min="0" max="1" value={prediction.probability}>{prediction.probability}</meter><small>{(prediction.probability * 100).toFixed(2)}%</small></li>
              {/each}
            </ol>
          {/if}
          <small class="api-note">{t(locale, "metomApiNote")}</small>
        </div>
      {/if}

      <div class="kuro-net-card">
        <div><span>{t(locale, "fullPageOcr")}</span><strong>KuroNet / RURI</strong><small>{t(locale, "loginReservation")}</small></div>
        <a href={kuroNetUrl} target="_blank" rel="noreferrer">{t(locale, "openCurrentManifest")}</a>
      </div>

      <div class="analysis-card">
        <div class="analysis-title"><span>{t(locale, "recognitionConditions")}</span><strong>{countLabel(locale, page.result.length, "line")}</strong></div>
        <dl>
          <div><dt>{t(locale, "ocrModel")}</dt><dd>NDL古典籍OCR-Lite</dd></div>
          <div><dt>{t(locale, "iiifInput")}</dt><dd>Canvas / Image Service</dd></div>
          <div><dt>{t(locale, "ocrOutput")}</dt><dd>{t(locale, "coordinateText")}</dd></div>
        </dl>
      </div>

      <aside class="ndl-usage-notice" aria-label={t(locale, "ndlUsage")}>
        <strong>{t(locale, "softwareUsed")}</strong>
        <p>
          {t(locale, "ndlNoticeStart")}
          <a href="https://github.com/ndl-lab/ndlkotenocr-lite" target="_blank" rel="noreferrer">NDL古典籍OCR-Liteアプリケーション</a>
          {t(locale, "ndlNoticeMiddle")}
          <a href="https://github.com/ndl-lab/ndlkotenocr-lite/blob/master/LICENCE" target="_blank" rel="noreferrer">{t(locale, "terms")}</a>
          <br />{t(locale, "variantSoftware")} · <a href={itaijiSource.repository} target="_blank" rel="noreferrer">{t(locale, "github")}</a>
        </p>
      </aside>

      <footer class="source-note">
        <div><span class="seal">IIIF</span><p>{t(locale, "imageProvider", { attribution: manifestAttribution })}<br />{manifest.license.includes("publicdomain") ? t(locale, "publicDomain") : t(locale, "manifestTerms")}</p></div>
        <a href={manifest.url} target="_blank" rel="noreferrer">{t(locale, "manifestLink")}</a>
      </footer>
    </aside>
  </section>

  {#if ocrTextExpanded}
    <div
      class="ocr-text-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t(locale, "transcriptionResult")}
      tabindex="-1"
      onmousedown={(event) => { if (event.currentTarget === event.target) closeOcrTextExpanded(); }}
    >
      <section class="ocr-text-dialog">
        <header class="ocr-text-dialog-head">
          <div><span class="eyebrow">{t(locale, "recognitionResult")}</span><strong>{t(locale, "transcription")}</strong></div>
          <button class="ocr-text-close-button" type="button" onclick={closeOcrTextExpanded} aria-label={t(locale, "close")}>×</button>
        </header>
        <div class="ocr-text-dialog-body">
          <div class="reading-order"><span>{t(locale, "readingOrder")}</span><span>{ocrRegions.length ? t(locale, "canvasCoordinates") : t(locale, "noCoordinateData")}</span></div>
          {@render ocrFontSizeControl("ocr-font-size-expanded")}
          <div class="vertical-text expanded" style={ocrTextStyle}>{@render ocrResultList()}</div>
        </div>
      </section>
    </div>
  {/if}

  {#if pickerOpen}
    <div class="manifest-backdrop" role="presentation" onmousedown={(event) => { if (event.currentTarget === event.target) pickerOpen = false; }}>
      <div class="manifest-dialog" role="dialog" aria-modal="true" aria-labelledby="manifest-title">
        <header class="manifest-dialog-head">
          <div><span class="eyebrow">{t(locale, "presentationApi")}</span><h2 id="manifest-title">{t(locale, "chooseManifestHeading")}</h2></div>
          <button type="button" onclick={() => (pickerOpen = false)} aria-label={t(locale, "close")}>×</button>
        </header>

        <div class="manifest-dialog-body">
          <section class="preset-section">
            <h3>{t(locale, "chooseFromKokusho")}</h3>
            <div class="preset-list">
              {#each manifestPresets as preset, index (preset.url)}
                <button type="button" class:active={manifest.url === preset.url} class="preset" onclick={() => void loadManifest(preset.url)} disabled={Boolean(loadingUrl)}>
                  <span class="preset-index">{String(index + 1).padStart(2, "0")}</span>
                  <span class="preset-copy"><strong>{preset.title}</strong><small>{presetDetail(index)}</small></span>
                  <span class="preset-tag">{loadingUrl === preset.url ? t(locale, "loadingManifest") : presetTag(index)}</span>
                </button>
              {/each}
            </div>
          </section>

          <form class="manifest-form" onsubmit={(event) => { event.preventDefault(); void loadManifest(manifestUrl); }}>
            <h3>{t(locale, "specifyUrl")}</h3>
            <label for="manifest-url">{t(locale, "manifestUrl")}</label>
            <textarea id="manifest-url" bind:value={manifestUrl} rows="4" spellcheck="false"></textarea>
            <p>{t(locale, "manifestApiDescription")}</p>
            {#if loadError}<div class="manifest-error" role="alert">{localizeError(loadError, locale, "errorManifestGeneric")}</div>{/if}
            <button class="load-button" type="submit" disabled={Boolean(loadingUrl)}>{loadingUrl ? t(locale, "loadingManifest") : t(locale, "openManifest")}</button>
          </form>
        </div>

        <footer class="manifest-dialog-foot"><span>{t(locale, "currentMaterial")}</span><strong>{manifestTitle}</strong><small>{countLabel(locale, manifest.pages.length, "canvas")}</small></footer>
      </div>
    </div>
  {/if}
</main>
