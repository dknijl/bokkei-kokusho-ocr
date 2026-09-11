import { test, expect } from "@playwright/test";
import { readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";

test("public annotation preprocessing ablation (diagnostic; training-overlap excluded from approval)", async ({ page, context }) => {
  const file = process.env.OCR_GROUND_TRUTH ?? "work/ocr-evaluation/ground-truth.json";
  try { await access(file); } catch { test.skip(true, "Import public annotation or set OCR_GROUND_TRUTH"); }
  const truth = JSON.parse(await readFile(file, "utf8"));
  await context.route("https://raw.githubusercontent.com/ndl-lab/ndlkotenocr-lite/**", async route => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    await route.fulfill({ path: resolve("work/ocr-evaluation/models", name), headers: { "access-control-allow-origin": "*" } });
  });
  await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  await context.route("**/src/lib/ocr/ocr.worker.ts*", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: 'Object.defineProperty(navigator, "gpu", { value: undefined });\n' + await response.text() });
  });
  const names: string[] = [];
  await page.exposeFunction("saveAblation", async (name: string, run: unknown) => {
    names.push(name);
    await writeFile(`work/ocr-evaluation/ablation-${name}.json`, JSON.stringify(run, null, 2));
  });
  await page.goto("./");
  await page.evaluate(async (pages) => {
    const { runPreprocessingAblation } = await import("/ocr/src/lib/ocr/ablation.ts");
    const { executeOcrPage } = await import("/ocr/src/lib/ocr/worker-client.ts");
    const { normalizeNdlOcrOptions } = await import("/ocr/src/lib/ocr/profiles.ts");
    const legacyPath = "/ocr/work/ocr-evaluation/legacy/src/lib/ndl-ocr.ts";
    const legacy = await import(/* @vite-ignore */ legacyPath);
    await runPreprocessingAblation({ pages, ocrOptions: normalizeNdlOcrOptions({ profile: "balanced" }),
      recognize: executeOcrPage, legacyRecognize: legacy.recognizePageWithNdlLite,
      onVariant: (name, run) => (window as any).saveAblation(name, run),
    });
  }, truth);
  expect(names).toEqual(["original", "auto", "grayscale-contrast", "background-normalized", "sauvola", "adaptive-binary", "legacy"]);
});
