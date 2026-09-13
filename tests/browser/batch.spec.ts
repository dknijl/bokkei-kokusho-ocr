import { test, expect, type Page } from "@playwright/test";
import { ZipReader, BlobReader, TextWriter } from "@zip.js/zip.js";
import { readFile } from "node:fs/promises";
import { OCR_PIPELINE_VERSION } from "../../src/lib/ocr/benchmark";
import { NDL_MODEL_REVISION } from "../../src/lib/ocr/model-revision";
import { NDL_LATEST_REVISION_URL } from "../../src/lib/ocr/model-source";

const manifestUrl = "https://kokusho.nijl.ac.jp/biblio/200021552/manifest";
const service = "https://example.test/iiif";
const manifest = {
  id: manifestUrl, type: "Manifest", label: { ja: ["一括OCR試験"] }, viewingDirection: "right-to-left",
  license: "https://creativecommons.org/publicdomain/mark/1.0/",
  items: Array.from({ length: 5 }, (_, index) => ({
    id: `${manifestUrl}/canvas/${index + 1}`, type: "Canvas", width: 1000, height: 2000, label: { ja: [`コマ${index + 1}`] },
    items: [{ type: "AnnotationPage", items: index === 1 ? [] : [{ motivation: "painting", body: {
      id: `${service}/${index + 1}/full/max/0/default.jpg`, type: "Image", width: 2000, height: 4000,
      service: [{ id: `${service}/${index + 1}`, type: "ImageService3", profile: "level2" }],
    } }] }],
  })),
};

async function setup(page: Page, failThird = false, settings: { delay?: number; supportedOnly?: boolean } = {}) {
  await page.route(NDL_LATEST_REVISION_URL, route => route.fulfill({ json: { sha: NDL_MODEL_REVISION } }));
  const fixture = settings.supportedOnly ? { ...manifest, items: manifest.items.filter((_, index) => index !== 1) } : manifest;
  await page.route(manifestUrl, (route) => route.fulfill({ json: fixture }));
  await page.route("https://example.test/**/info.json", (route) => route.fulfill({ json: {
    type: "ImageService3", width: 2000, height: 4000, profile: "level2",
  } }));
  await page.route("https://example.test/**/default.jpg", (route) => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="200"><rect width="100" height="200" fill="#eee9dc"/></svg>' }));
  await page.addInitScript(({ failThird, delay, pipelineVersion }) => {
    const NativeWorker = window.Worker;
    class MockWorker extends EventTarget {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      stopped = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super();
        if (!String(url).includes("ocr.worker")) return new NativeWorker(url, options) as unknown as MockWorker;
      }
      terminate() { this.stopped = true; }
      postMessage(data: any) {
        const calls = JSON.parse(sessionStorage.getItem("mock-calls") ?? "[]");
        calls.push(data.page.canvasId); sessionStorage.setItem("mock-calls", JSON.stringify(calls));
        const revisions = JSON.parse(sessionStorage.getItem("mock-revisions") ?? "[]");
        revisions.push(data.options.modelRevision); sessionStorage.setItem("mock-revisions", JSON.stringify(revisions));
        setTimeout(() => {
          if (!this.stopped) this.onmessage?.(new MessageEvent("message", { data: { id: data.id, type: "progress", progress: {
            stage: "recognize", percent: 60, messageKey: "progressRecognize", completed: 1, total: 2, params: { current: 1, total: 2 },
          } } }));
        }, Math.min(50, delay / 2));
        setTimeout(() => {
          if (this.stopped) return;
          if (failThird && data.page.canvasId.endsWith("/3")) {
            this.onmessage?.(new MessageEvent("message", { data: { id: data.id, type: "error", error: { kind: "image", message: "HTTP 404" } } }));
            return;
          }
          const empty = data.page.canvasId.endsWith("/5");
          this.onmessage?.(new MessageEvent("message", { data: { id: data.id, type: "result", result: {
            imageWidth: 2000, imageHeight: 4000, lines: empty ? [] : [{ text: "𠮷野の山", detectionScore: 0.9, readingOrder: 0,
              recognitionScore: 0.9, region: { x: 100, y: 200, width: 100, height: 1000 } }],
            provider: "WASM", revision: data.options.modelRevision ?? "ede4283845cdc0ba2bda8b7ebfc3dc80b33c92c8", pipelineVersion,
            profile: data.options.profile, options: data.options,
            stats: { detectionCount: empty ? 0 : 1, modelInferenceCount: 2, initialRecognitions: empty ? 0 : 1,
              extraRecognitions: 0, extraRecognitionAttempts: 0, adaptiveTiles: 0, highResolutionRetries: 0,
              additionalCropRequests: 0, additionalCropFailures: 0, maxCanvasPixels: 2000000, durationMs: 5 },
          } } }));
        }, delay);
      }
    }
    window.Worker = MockWorker as unknown as typeof Worker;
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
  }, { failThird, delay: settings.delay ?? 180, pipelineVersion: OCR_PIPELINE_VERSION });
  await page.goto("./");
  await expect(page.locator(".rail-count")).toContainText(settings.supportedOnly ? "04" : "05");
}

test("batch retains canvas order, failed/empty pages and downloads a real ZIP", async ({ page }) => {
  await setup(page, true);
  await page.locator(".batch-start").click();
  await expect(page.locator(".batch-status")).toContainText("5/5");
  await expect(page.locator(".batch-status")).toContainText("失敗・未対応 2");
  await expect(page.locator(".batch-phase")).toHaveText("全コマの処理完了（失敗・未対応あり）");
  await expect(page.locator(".batch-percent")).toContainText("100%");
  const download = page.waitForEvent("download");
  await page.locator(".batch-export").click();
  const file = await download;
  const buffer = await readFile((await file.path())!);
  const reader = new ZipReader(new BlobReader(new Blob([buffer])));
  const entries = await reader.getEntries();
  const texts = new Map<string, string>();
  for (const entry of entries) if (!entry.directory) texts.set(entry.filename, await entry.getData(new TextWriter()));
  await reader.close();
  expect(texts.get("texts/00001.txt")).toBe("𠮷野の山\n");
  expect(texts.get("texts/00005.txt")).toBe("");
  expect(texts.has("errors/00002.txt")).toBeTruthy();
  expect(texts.get("errors/00003.txt")).toContain("HTTP 404");
  expect(texts.get("index.csv")).toContain("no-text-detected");
  expect(texts.get("index.csv")).toContain("unsupported");
  expect([...texts.keys()].sort()).toEqual([
    "errors/00002.txt", "errors/00003.txt", "index.csv", "texts/00001.txt", "texts/00004.txt", "texts/00005.txt",
  ]);
  expect(texts.get("index.csv")).not.toContain("pending");
  const csvRows = texts.get("index.csv")!.trimEnd().split("\n");
  expect(csvRows[0]).toBe("number,label,canvasId,status,file,inThisArchive,ocrConfidencePercent");
  expect(csvRows.slice(1).map(row => row.split(",").at(-1))).toEqual(['"90"', '""', '""', '"90"', '""']);
});

test("pause saves the active page, reload resumes without redoing completed canvases", async ({ page }) => {
  await setup(page);
  await page.locator(".batch-start").click();
  await page.getByRole("button", { name: "一時停止", exact: true }).click();
  await expect(page.getByRole("button", { name: "再開", exact: true })).toBeVisible();
  await expect(page.locator(".batch-phase")).toHaveText("一時停止中");
  const before = await page.evaluate(() => JSON.parse(sessionStorage.getItem("mock-calls") ?? "[]"));
  await page.reload();
  await expect(page.getByRole("button", { name: "再開", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "再開", exact: true }).click();
  await expect(page.locator(".batch-status")).toContainText("5/5");
  const calls = await page.evaluate(() => JSON.parse(sessionStorage.getItem("mock-calls") ?? "[]"));
  expect(calls.length).toBe(4);
  expect(new Set(calls).size).toBe(4);
  expect(calls.slice(0, before.length)).toEqual(before);
});

test("page navigation does not cancel batch work and single OCR is disabled while running", async ({ page }) => {
  await setup(page);
  await page.locator(".batch-start").click();
  await expect(page.locator(".run-full-ocr")).toBeDisabled();
  await page.getByRole("button", { name: "次 →", exact: true }).click();
  await expect(page.locator(".batch-status")).toContainText("5/5");
});

test("single-page re-OCR performs inference even when a batch result is saved", async ({ page }) => {
  await setup(page);
  await page.locator(".batch-start").click();
  await expect(page.locator(".batch-phase")).toContainText("全コマの処理完了");
  await page.locator(".run-full-ocr").click();
  await expect(page.locator(".run-full-ocr")).toBeEnabled();
  const calls = await page.evaluate(() => JSON.parse(sessionStorage.getItem("mock-calls") ?? "[]"));
  expect(calls.filter((id: string) => id.endsWith("/1"))).toHaveLength(2);
});

test("resume keeps the saved model when latest changes; a new job uses the newer revision", async ({ page }) => {
  await setup(page, false, { delay: 900, supportedOnly: true });
  let latest = "a".repeat(40), lookups = 0;
  await page.route(NDL_LATEST_REVISION_URL, route => { lookups++; return route.fulfill({ json: { sha: latest } }); });
  await page.locator(".batch-start").click();
  await expect(page.locator(".batch-current")).toContainText("60%");
  await page.getByRole("button", { name: "一時停止", exact: true }).click();
  await expect(page.locator(".batch-phase")).toHaveText("一時停止中");
  latest = "b".repeat(40);
  await page.evaluate(async () => {
    const { writeOcrModelAsset } = await import("/ocr/src/lib/ocr/model-cache.ts");
    await writeOcrModelAsset("ndl-ocr:resolved-revision:master", new TextEncoder().encode("a".repeat(40)).buffer, 0);
  });
  await page.reload();
  await page.getByRole("button", { name: "再開", exact: true }).click();
  await expect(page.locator(".batch-phase")).toHaveText("全コマのOCR完了");
  expect(lookups).toBe(1);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("mock-revisions")!))).toEqual(Array(4).fill("a".repeat(40)));
  await page.locator(".batch-start").click();
  await expect(page.locator(".batch-phase")).toHaveText("処理中");
  await expect(page.locator(".batch-phase")).toHaveText("全コマのOCR完了");
  expect(lookups).toBe(2);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("mock-revisions")!).slice(4))).toEqual(Array(4).fill("b".repeat(40)));
});

test("IndexedDB commits page result and job checkpoint atomically", async ({ page }) => {
  await setup(page);
  const state = await page.evaluate(async () => {
    const path = "/ocr/src/lib/ocr/batch.ts";
    const { createOcrJob, indexedDbJobStore, latestOcrJob } = await import(path);
    const iiifPath = "/ocr/src/lib/iiif.ts";
    const { initialManifest } = await import(iiifPath);
    const profilePath = "/ocr/src/lib/ocr/profiles.ts";
    const { DEFAULT_NDL_OCR_OPTIONS } = await import(profilePath);
    const job = await createOcrJob(initialManifest, DEFAULT_NDL_OCR_OPTIONS);
    const row = await indexedDbJobStore.getPage(job.id, 0);
    // The DataCloneError aborts the transaction after the page put was queued.
    await indexedDbJobStore.commitPage({ ...job, completed: 1, invalid: () => undefined }, { ...row, status: "done" }).catch(() => undefined);
    return { row: (await indexedDbJobStore.getPage(job.id, 0)).status, completed: (await latestOcrJob(job.manifestUrl)).completed };
  });
  expect(state).toEqual({ row: "pending", completed: 0 });
});

test("narrow batch controls remain reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await expect(page.locator(".batch-start")).toBeVisible();
  expect((await page.locator(".canvas-wrap").boundingBox())!.height).toBeGreaterThan(200);
  await page.screenshot({ path: "work/test-results/batch-mobile.png", fullPage: true });
});

for (const width of [1280, 390]) {
  test(`batch visibly reports percentage and completion at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page, false, { delay: 900, supportedOnly: true });
    await page.locator(".batch-start").click();
    await expect(page.locator(".batch-phase")).toHaveText("処理中");
    await expect(page.locator(".batch-percent")).toContainText("0%");
    await expect(page.locator(".batch-current")).toContainText("60%");
    await expect(page.locator(".batch-percent")).toContainText("25%");
    await expect(page.locator(".batch-phase")).toHaveText("全コマのOCR完了");
    await expect(page.locator(".batch-percent")).toContainText("100%");
    await expect(page.getByRole("progressbar", { name: "全体の保存済みコマ数" })).toHaveJSProperty("value", 4);
    await expect(page.locator(".batch-note")).toHaveCount(0);
    await expect(page.locator(".batch-detail")).toContainText("ZIPでダウンロードできます");
    const contrast = await page.locator(".batch-ocr").evaluate(root => {
      const luminance = (color: string) => {
        const components = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => {
          const n = v / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
        });
        return components[0] * 0.2126 + components[1] * 0.7152 + components[2] * 0.0722;
      };
      const background = luminance(getComputedStyle(root).backgroundColor);
      return Array.from(root.querySelectorAll(".batch-phase, .batch-percent, .batch-counts, .batch-detail, .batch-title, .batch-note"), element => {
        const foreground = luminance(getComputedStyle(element).color);
        return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
      });
    });
    expect(Math.min(...contrast)).toBeGreaterThanOrEqual(4.5);
    const pane = (await page.locator(".image-stage").boundingBox())!;
    for (const selector of [".batch-phase", ".batch-percent", ".batch-counts"]) {
      const box = (await page.locator(selector).boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width);
    }
    await page.screenshot({ path: `work/test-results/batch-completed-${width}.png`, fullPage: true });
    await page.reload();
    await expect(page.locator(".batch-phase")).toHaveText("全コマのOCR完了");
    await expect(page.locator(".batch-percent")).toContainText("100%");
  });
}

test("cancellation shows a saved checkpoint instead of completion", async ({ page }) => {
  await setup(page, false, { delay: 3000 });
  await page.locator(".batch-start").click();
  await expect(page.locator(".batch-current")).toContainText("60%");
  await page.getByRole("button", { name: "中止", exact: true }).click();
  await expect(page.locator(".batch-phase")).toHaveText("中止しました");
  await expect(page.locator(".batch-percent")).toContainText("0%");
  await expect(page.getByRole("button", { name: "再開", exact: true })).toBeEnabled();
});

test("a failed durable save cannot report progress or completion", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (this.name === "job-pages" && value.status === "done") throw new DOMException("Storage full (simulated)", "QuotaExceededError");
      return put.call(this, value, key);
    };
  });
  await page.locator(".batch-start").click();
  await expect(page.locator(".batch-error")).toContainText("Storage full");
  await expect(page.locator(".batch-phase")).toHaveText("一時停止中");
  await expect(page.locator(".batch-percent")).toContainText("0%");
  await expect(page.locator(".batch-counts")).toContainText("保存済み 0/5");
});

test("old pipeline results remain exportable without restoring or reusing stale joined lines", async ({ page }) => {
  await setup(page);
  await page.evaluate(async manifest => {
    const { createOcrJob, indexedDbJobStore } = await import("/ocr/src/lib/ocr/batch.ts");
    const { parseManifest } = await import("/ocr/src/lib/iiif.ts");
    const { DEFAULT_NDL_OCR_OPTIONS } = await import("/ocr/src/lib/ocr/profiles.ts");
    const { buildOcrCacheKeyForPage, cacheEntryFromResult } = await import("/ocr/src/lib/ocr/cache.ts");
    const job = await createOcrJob(parseManifest(manifest, manifest.id), DEFAULT_NDL_OCR_OPTIONS);
    const row = await indexedDbJobStore.getPage(job.id, 0);
    const result = { lines: [{ text: "古い結合結果", region: { x: 100, y: 100, width: 100, height: 2000 }, detectionScore: .8 }],
      revision: job.modelRevision, pipelineVersion: "frontend-ocr-source-worker-v1", imageWidth: 2000, imageHeight: 4000,
      provider: "WASM", profile: job.options.profile, options: job.options };
    const key = buildOcrCacheKeyForPage(row.page, job.manifestUrl, job.modelRevision, result.pipelineVersion, job.options);
    await indexedDbJobStore.commitPage({ ...job, pipelineVersion: result.pipelineVersion, completed: 1, nextIndex: 1, status: "paused" },
      { ...row, status: "done", result }, cacheEntryFromResult(key, row.page, job.manifestUrl, result));
  }, manifest);
  await page.reload();
  await expect(page.locator(".batch-status .batch-note")).toHaveText("OCRを再度実行する場合は「全コマをOCR」を押してください。");
  await expect(page.getByRole("button", { name: "再開", exact: true })).toBeDisabled();
  await expect(page.locator(".batch-export")).toBeEnabled();
  await expect(page.locator(".vertical-text")).not.toContainText("古い結合結果");
  await page.locator(".batch-start").click();
  await expect(page.locator(".batch-counts")).toContainText("保存済み 5/5");
  await expect(page.locator(".vertical-text")).toContainText("𠮷野の山");
  const calls = await page.evaluate(() => JSON.parse(sessionStorage.getItem("mock-calls") ?? "[]"));
  expect(calls).toContain(`${manifestUrl}/canvas/1`);
});

test("desktop toolbar controls fit inside the image pane", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setup(page);
  const pane = (await page.locator(".image-stage").boundingBox())!;
  for (const selector of [".run-full-ocr", "#ocr-preprocessing", "#viewer-zoom"]) {
    const control = (await page.locator(selector).boundingBox())!;
    expect(control.x + control.width).toBeLessThanOrEqual(pane.x + pane.width);
  }
});

test("1000 simulated canvases release actual image buffers after each durable save", async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page);
  const report = await page.evaluate(async () => {
    const { createOcrJob, BatchController } = await import("/ocr/src/lib/ocr/batch.ts");
    const { initialManifest } = await import("/ocr/src/lib/iiif.ts");
    const { DEFAULT_NDL_OCR_OPTIONS } = await import("/ocr/src/lib/ocr/profiles.ts");
    const { createOcrCanvas, releaseOcrCanvas, canvasCounters, resetCanvasCounters } = await import("/ocr/src/lib/ocr/canvas.ts");
    const { preprocessCanvas } = await import("/ocr/src/lib/ocr/preprocessing.ts");
    const manifest = { ...initialManifest, pages: Array.from({ length: 1000 }, (_, i) => ({ ...initialManifest.pages[0], canvasId: `stress-${i}`, canvasIndex: i })) };
    const job = await createOcrJob(manifest, DEFAULT_NDL_OCR_OPTIONS);
    let maximumLive = 0, saved = 0;
    const final = await new BatchController().run(job, {
      prepare: async page => ({ page, key: page.canvasId }), readCache: async () => undefined, onChange: () => undefined,
      onPageSaved: () => { saved++; maximumLive = Math.max(maximumLive, canvasCounters().live); },
      recognize: async (_page, options) => {
        resetCanvasCounters();
        const canvas = createOcrCanvas(); canvas.width = 64; canvas.height = 256;
        const context = canvas.getContext("2d")!; context.fillStyle = "#eee9dd"; context.fillRect(0, 0, 64, 256);
        context.fillStyle = "#321"; context.fillRect(25, 10, 5, 220);
        let candidate = null;
        try { candidate = preprocessCanvas(canvas, "sauvola"); }
        finally { releaseOcrCanvas(candidate); releaseOcrCanvas(canvas); }
        return { lines: [], imageWidth: 64, imageHeight: 256, provider: "WASM", revision: job.modelRevision,
          pipelineVersion: job.pipelineVersion, profile: options.profile, options,
          stats: { detectionCount: 0, modelInferenceCount: 0, initialRecognitions: 0, extraRecognitions: 0, extraRecognitionAttempts: 0,
            adaptiveTiles: 0, highResolutionRetries: 0, additionalCropRequests: 0, additionalCropFailures: 0, maxCanvasPixels: 16384, durationMs: 0 } };
      },
    });
    return { completed: final.completed, saved, maximumLive, counters: canvasCounters() };
  });
  expect(report).toEqual({ completed: 1000, saved: 1000, maximumLive: 0, counters: { live: 0, peak: 2, maxPixels: 16384 } });
});

test("streaming ZIP acquires the destination during the click and aborts an incomplete write", async ({ page }) => {
  await setup(page);
  await page.locator(".batch-start").click();
  await expect(page.locator(".batch-status")).toContainText("5/5");
  await page.evaluate(() => {
    const state = { clicked: false, closed: false, aborted: false, writes: 0 };
    (window as any).streamTest = state;
    Object.defineProperty(window, "showSaveFilePicker", { value: () => {
      state.clicked = navigator.userActivation.isActive;
      return Promise.resolve({ createWritable: async () => new WritableStream({
        write() { if (++state.writes === 2) throw new Error("disk full (simulated)"); },
        close() { state.closed = true; }, abort() { state.aborted = true; },
      }) });
    }, configurable: true });
  });
  await page.locator(".batch-export").click();
  await expect(page.locator(".batch-error")).toContainText("disk full");
  const stream = await page.evaluate(() => (window as any).streamTest);
  expect(stream.clicked).toBe(true); expect(stream.closed).toBe(false);
  await expect(page.locator(".batch-status")).toContainText("5/5");
  await page.evaluate(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }));
  const download = page.waitForEvent("download");
  await page.locator(".batch-export").click(); await download;
});

test("v2 uses the first sequence and both versions preserve missing and composite canvases", async ({ page }) => {
  await setup(page);
  const parsed = await page.evaluate(async () => {
    const { parseManifest } = await import("/ocr/src/lib/iiif.ts");
    const resource = { "@id": "https://example.test/image.jpg", "@type": "dctypes:Image", width: 2000, height: 4000 };
    const raw = { "@id": "https://example.test/v2", viewingDirection: "right-to-left", sequences: [
      { canvases: [
        { "@id": "c1", width: 1000, height: 2000, images: [{ resource }] },
        { "@id": "c2", images: [] },
        { "@id": "c3", images: [{ resource }, { resource }] },
      ] }, { canvases: [{ "@id": "must-not-run", images: [{ resource }] }] },
    ] };
    const v2 = parseManifest(raw, raw["@id"]);
    const v3 = parseManifest({ id: "https://example.test/v3", items: [{ id: "complex", items: [{ items: [{ motivation: "painting", body: [{ id: "a", type: "Image" }, { id: "b", type: "Image" }] }] }] }] }, "https://example.test/v3");
    return { ids: v2.pages.map(p => p.canvasId), indices: v2.pages.map(p => p.canvasIndex), availability: v2.pages.map(p => p.ocrAvailability),
      source: v2.pages[0].sourceWidth, canvas: v2.pages[0].width, composite: v3.pages[0].ocrAvailability };
  });
  expect(parsed).toEqual({ ids: ["c1", "c2", "c3"], indices: [0, 1, 2], availability: ["supported", "unsupported", "unsupported"], source: 2000, canvas: 1000, composite: "unsupported" });
});
