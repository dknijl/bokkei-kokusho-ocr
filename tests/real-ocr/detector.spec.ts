import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NDL_MODEL_REVISION } from "../../src/lib/ocr/model-revision";

test("shared detection returns source coordinates without loading PARSeq, then upgrades to full OCR", async ({ page, context }) => {
  const requests: string[] = [];
  await context.route("https://raw.githubusercontent.com/ndl-lab/ndlkotenocr-lite/**", route => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    requests.push(name);
    return route.fulfill({ path: resolve("work/ocr-evaluation/models", name), headers: { "access-control-allow-origin": "*" } });
  });
  const manifest = JSON.parse(await readFile("work/ocr-evaluation/manuscript-manifest.json", "utf8"));
  await page.goto("./");
  const detected = await page.evaluate(async manifest => {
    const { parseManifest } = await import("/ocr/src/lib/iiif.ts");
    const { detectPageLines } = await import("/ocr/src/lib/ndl-ocr.ts");
    const { normalizeNdlOcrOptions } = await import("/ocr/src/lib/ocr/profiles.ts");
    const parsed = parseManifest(manifest, manifest.id ?? manifest["@id"]);
    // Canvas dimensions deliberately differ from the original image dimensions.
    return detectPageLines({ ...parsed.pages[0], width: 100, height: 150 }, normalizeNdlOcrOptions());
  }, manifest);
  expect(requests).toEqual(["rtmdet-s-1280x1280.onnx"]);
  expect(detected).toMatchObject({ imageWidth: 3744, imageHeight: 5616, detectorRevision: NDL_MODEL_REVISION });
  expect(detected.detections).toHaveLength(14);
  expect(detected.detections.some(box => box.x > 2700)).toBe(true);
  expect(detected.stats).toMatchObject({ initialRecognitions: 0, modelInferenceCount: 1, liveCanvasesAfterPage: 0 });

  const result = await page.evaluate(async manifest => {
    const { parseManifest } = await import("/ocr/src/lib/iiif.ts");
    const { recognizePage, getPageOcrCacheIdentity } = await import("/ocr/src/lib/page-ocr.ts");
    const { releaseNdlOcrModels } = await import("/ocr/src/lib/ndl-ocr.ts");
    const parsed = parseManifest(manifest, manifest.id ?? manifest["@id"]);
    try {
      const result = await recognizePage(parsed.pages[0]);
      const identity = await getPageOcrCacheIdentity("ndl-parseq", undefined, undefined, "a".repeat(40));
      return { result, identity };
    } finally { await releaseNdlOcrModels(); }
  }, manifest);
  expect(requests.sort()).toEqual(["NDLmoji.yaml", "parseq-ndl-32x384-tiny-10.onnx", "rtmdet-s-1280x1280.onnx"]);
  expect(result.result.lines).toHaveLength(14);
  expect(result.result.detectorRevision).toBe(result.result.revision);
  expect(result.result.recognizerRevision).toBe(result.result.revision);
  expect(result.result.stats.liveCanvasesAfterPage).toBe(0);
  expect(result.identity.detectorRevision).toBe("a".repeat(40));
  expect(result.identity.recognizerRevision).toBe("a".repeat(40));
});
