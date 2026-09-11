import { test, expect } from "@playwright/test";
import { HONKOKU_V18_RUNTIME, HONKOKU_V18_UPSTREAM_COMMIT } from "../../src/lib/ocr/models/manifest";

const manifestUrl = "https://models.example.test/honkoku/manifest.json";
const manifest = {
  schemaVersion: 1, engineId: "honkoku-v18", upstreamRepository: "yuta1984/honkoku-ocr-web",
  upstreamCommit: HONKOKU_V18_UPSTREAM_COMMIT, license: "CC-BY-4.0", runtime: HONKOKU_V18_RUNTIME,
  files: Object.fromEntries(["encoderInt8", "encoderFp16", "decoderPrefillInt8", "decoderStepInt8", "vocab"]
    .map(role => [role, { url: `${role}.bin`, sha256: "a".repeat(64), bytes: 1 }])),
};

test.beforeEach(async ({ page }) => {
  await page.route(manifestUrl, route => route.fulfill({ json: manifest }));
  await page.addInitScript(() => {
    const workers: FakeWorker[] = [];
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      stopped = false;
      calls: any[] = [];
      constructor() { workers.push(this); }
      postMessage(data: any) {
        this.calls.push(data);
        if (data.type === "initialize" && !(window as any).holdHonkokuInit) queueMicrotask(() => this.emit({ type: "ready", runId: data.runId, provider: "WASM" }));
        if (data.type === "recognize" && (window as any).autoHonkokuResult) queueMicrotask(() => this.emit({
          type: "line-result", runId: data.runId, lineId: data.lineId,
          result: { text: "山", rawKoji: "<ruby>山<rt>やま</rt></ruby>", outputFormat: "koji", diagnostics: { generatedTokens: 4, stopReason: "eos" } },
        }));
      }
      emit(data: unknown) { this.onmessage?.(new MessageEvent("message", { data })); }
      terminate() { this.stopped = true; }
    }
    Object.assign(window, { Worker: FakeWorker, honkokuWorkers: workers });
  });
  await page.goto("./");
});

for (const action of ["abort", "dispose"] as const) {
  test(`${action} settles initialization while the worker is still loading`, async ({ page }) => {
    await page.evaluate(async manifestUrl => {
      const { HonkokuV18Recognizer } = await import("/ocr/src/lib/ocr/recognizers/honkoku-v18.ts");
      const state = window as any;
      state.holdHonkokuInit = true;
      state.initRecognizer = new HonkokuV18Recognizer(manifestUrl);
      state.initController = new AbortController();
      state.initResult = state.initRecognizer.initialize({ signal: state.initController.signal }).catch((error: Error) => error.name);
    }, manifestUrl);
    await expect.poll(() => page.evaluate(() => (window as any).honkokuWorkers.length)).toBe(1);
    const result = await page.evaluate(async action => {
      const state = window as any;
      if (action === "abort") state.initController.abort(); else await state.initRecognizer.dispose();
      return { name: await state.initResult, stopped: state.honkokuWorkers[0].stopped };
    }, action);
    expect(result).toEqual({ name: "AbortError", stopped: true });
  });
}

test("page adapter consumes shared detector coordinates and retains Koji text and loaded model identity", async ({ page }) => {
  // Only this integration fixture replaces detection; detector.spec.ts exercises the real RTMDet.
  await page.route("**/src/lib/ndl-ocr.ts", route => route.fulfill({ contentType: "text/javascript", body: `
    export async function detectPageLines(page, options) {
      return { imageWidth: 300, imageHeight: 600, options, detectorRevision: "a".repeat(40), stats: {},
        detections: [{ x: 50, y: 50, width: 30, height: 100, detectionScore: 0.9 }, { x: 100, y: 50, width: 30, height: 100, detectionScore: 0.9 }] };
    }
  ` }));
  let requests = 0;
  page.on("request", request => { if (request.url() === manifestUrl) requests++; });
  const result = await page.evaluate(async manifestUrl => {
    const state = window as any;
    state.autoHonkokuResult = true;
    const { initialManifest } = await import("/ocr/src/lib/iiif.ts");
    const { recognizePageWithHonkokuV18 } = await import("/ocr/src/lib/ocr/recognizers/honkoku-v18.ts");
    const { normalizeNdlOcrOptions } = await import("/ocr/src/lib/ocr/profiles.ts");
    const canvas = document.createElement("canvas"); canvas.width = 300; canvas.height = 600;
    const image = canvas.toDataURL();
    const page = { ...initialManifest.pages[0], width: 100, height: 200, imageServiceId: "", image };
    const result = await recognizePageWithHonkokuV18(page, normalizeNdlOcrOptions(), () => {}, undefined, manifestUrl);
    const worker = state.honkokuWorkers.at(-1);
    return { result, stopped: worker.stopped, crops: worker.calls.filter((call: any) => call.type === "recognize").map((call: any) => [call.crop.width, call.crop.height]) };
  }, manifestUrl);
  expect(result.result.lines).toHaveLength(2);
  expect(result.result).toMatchObject({ imageWidth: 300, imageHeight: 600, detectorRevision: "a".repeat(40), engineId: "honkoku-v18" });
  expect(result.result.lines.every(line => line.text === "山やま" && line.rawKoji?.includes("<ruby>") && line.generatedTokens === 4)).toBe(true);
  expect(result.result.modelManifestDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(result.crops).toEqual([[75, 190], [75, 190]]);
  expect(result.stopped).toBe(true);
  expect(requests).toBe(1);
});

test("recognition responses are matched by run and line and model errors settle the request", async ({ page }) => {
  const result = await page.evaluate(async manifestUrl => {
    const { HonkokuV18Recognizer } = await import("/ocr/src/lib/ocr/recognizers/honkoku-v18.ts");
    const recognizer = new HonkokuV18Recognizer(manifestUrl);
    await recognizer.initialize({});
    const worker = (window as any).honkokuWorkers.at(-1);
    let settled = false;
    const pending = recognizer.recognize({ crop: new ImageData(2, 2), lineId: "line-1" }).then(result => { settled = true; return result; });
    const request = worker.calls.at(-1);
    const output = { text: "山", rawKoji: "<ruby>山<rt>やま</rt></ruby>", outputFormat: "koji" };
    worker.emit({ type: "line-result", runId: "old-run", lineId: "line-1", result: output });
    worker.emit({ type: "line-result", runId: request.runId, lineId: "wrong-line", result: output });
    await Promise.resolve();
    const ignored = !settled;
    const busy = await recognizer.recognize({ crop: new ImageData(2, 2), lineId: "line-2" }).catch(error => error.message);
    worker.emit({ type: "line-result", runId: request.runId, lineId: "line-1", result: output });
    const value = await pending;
    const failure = recognizer.recognize({ crop: new ImageData(2, 2), lineId: "line-2" }).catch(error => error.message);
    worker.emit({ type: "error", runId: worker.calls.at(-1).runId, lineId: "line-2", error: "decoder failed" });
    const error = await failure;
    const digest = recognizer.modelManifestDigest;
    await recognizer.dispose();
    return { ignored, busy, value, error, digest, stopped: worker.stopped };
  }, manifestUrl);
  expect(result.ignored).toBe(true);
  expect(result.busy).toContain("still running");
  expect(result.value.rawKoji).toContain("<ruby>");
  expect(result.error).toBe("decoder failed");
  expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(result.stopped).toBe(true);
});

for (const failure of ["abort", "error", "messageerror", "dispose"] as const) {
  test(`${failure} ends recognition and permits clean reinitialization`, async ({ page }) => {
    const result = await page.evaluate(async ({ manifestUrl, failure }) => {
      const { HonkokuV18Recognizer } = await import("/ocr/src/lib/ocr/recognizers/honkoku-v18.ts");
      const recognizer = new HonkokuV18Recognizer(manifestUrl);
      await recognizer.initialize({});
      const worker = (window as any).honkokuWorkers.at(-1);
      const controller = new AbortController();
      const pending = recognizer.recognize({ crop: new ImageData(1, 1), lineId: "line" }, { signal: controller.signal }).catch(error => error.name);
      if (failure === "abort") controller.abort();
      else if (failure === "error") worker.onerror(new ErrorEvent("error", { message: "worker crashed" }));
      else if (failure === "messageerror") worker.onmessageerror();
      else await recognizer.dispose();
      const name = await pending;
      await recognizer.initialize({});
      const current = (window as any).honkokuWorkers.at(-1);
      const resumed = recognizer.recognize({ crop: new ImageData(1, 1), lineId: "new-line" });
      worker.onerror(new ErrorEvent("error", { message: "late error from disposed worker" }));
      current.emit({ type: "line-result", runId: current.calls.at(-1).runId, lineId: "new-line", result: { text: "山", outputFormat: "plain" } });
      const text = (await resumed).text;
      await recognizer.dispose();
      return { name, text, stopped: worker.stopped, created: (window as any).honkokuWorkers.length };
    }, { manifestUrl, failure });
    expect(result.name).toBe(failure === "abort" || failure === "dispose" ? "AbortError" : "Error");
    expect(result.text).toBe("山");
    expect(result.stopped).toBe(true);
    expect(result.created).toBe(2);
  });
}

test("an already-aborted initialization does not fetch or start a worker", async ({ page }) => {
  let requests = 0;
  page.on("request", request => { if (request.url() === manifestUrl) requests++; });
  const result = await page.evaluate(async manifestUrl => {
    const { HonkokuV18Recognizer } = await import("/ocr/src/lib/ocr/recognizers/honkoku-v18.ts");
    const controller = new AbortController(); controller.abort();
    const recognizer = new HonkokuV18Recognizer(manifestUrl);
    const name = await recognizer.initialize({ signal: controller.signal }).catch(error => error.name);
    return { name, workers: (window as any).honkokuWorkers.length };
  }, manifestUrl);
  expect(result).toEqual({ name: "AbortError", workers: 0 });
  expect(requests).toBe(0);
});
