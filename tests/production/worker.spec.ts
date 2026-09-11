import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ZipReader, BlobReader, TextWriter } from "@zip.js/zip.js";
import { NDL_LATEST_REVISION_URL } from "../../src/lib/ocr/model-source";
import { NDL_MODEL_REVISION } from "../../src/lib/ocr/model-revision";
test("built application performs real OCR with the emitted worker and WASM assets", async ({ page, context }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  // Exercise the real Blob download path; headless Chromium cannot choose a native save destination.
  await page.addInitScript(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }));
  const manifest = JSON.parse(await readFile("work/ocr-evaluation/manuscript-manifest.json", "utf8"));
  await context.route(NDL_LATEST_REVISION_URL, route => route.fulfill({ json: { sha: NDL_MODEL_REVISION } }));
  await context.route("https://kokusho.nijl.ac.jp/biblio/200021552/manifest", route => route.fulfill({ json: manifest }));
  const modelRequests: string[] = [];
  await context.route("https://raw.githubusercontent.com/ndl-lab/ndlkotenocr-lite/**", route => {
    modelRequests.push(route.request().url());
    return route.fulfill({ path: resolve("work/ocr-evaluation/models", new URL(route.request().url()).pathname.split("/").at(-1)!), headers: { "access-control-allow-origin": "*" } });
  });
  const workers: string[] = [];
  page.on("worker", worker => workers.push(worker.url()));
  await page.goto("./");
  await page.locator(".run-full-ocr").click();
  await expect(page.locator("button[data-line-index]").first()).toBeVisible({ timeout: 150_000 });
  expect(workers.some(url => /\/assets\/ocr\.worker-.*\.js/.test(url))).toBe(true);
  await expect(page.locator(".run-full-ocr")).toBeEnabled();
  await expect(page.locator("button[data-line-index]")).toHaveCount(14);
  await page.locator(".batch-start").click();
  await expect(page.locator(".batch-phase")).toHaveText("全コマのOCR完了", { timeout: 150_000 });
  await expect(page.locator(".batch-percent")).toContainText("100%");
  await expect(page.locator(".batch-counts")).toContainText("保存済み 3/3 · 失敗・未対応 0");
  await expect(page.locator("button[data-line-index]")).toHaveCount(14);
  const download = page.waitForEvent("download");
  await page.locator(".batch-export").click();
  const file = await download;
  const buffer = await readFile((await file.path())!);
  const reader = new ZipReader(new BlobReader(new Blob([buffer])));
  const entries = await reader.getEntries();
  const text = await entries.find(entry => entry.filename === "texts/00001.txt")!.getData!(new TextWriter());
  expect(text!.trimEnd().split("\n")).toHaveLength(14);
  expect(entries.map(entry => entry.filename).sort()).toEqual([
    "index.csv", "texts/00001.txt", "texts/00002.txt", "texts/00003.txt",
  ]);
  const index = await entries.find(entry => entry.filename === "index.csv")!.getData!(new TextWriter());
  expect(index).not.toContain("pending");
  await reader.close();
  await writeFile("work/production-results/first-page.txt", text!);
  await page.screenshot({ path: "work/production-results/real-ocr.png", fullPage: true });
  await page.locator(".batch-ocr").screenshot({ path: "work/production-results/batch-complete.png" });
  expect(modelRequests).toHaveLength(3);
  expect(modelRequests.every(url => url.includes(`/${NDL_MODEL_REVISION}/`))).toBe(true);
  const workerCount = workers.length;
  await page.reload();
  await expect(page.locator(".batch-phase")).toHaveText("全コマのOCR完了");
  await page.locator(".run-full-ocr").click();
  await expect(page.locator(".run-full-ocr")).toBeEnabled({ timeout: 150_000 });
  await expect(page.locator("button[data-line-index]")).toHaveCount(14);
  // Reload discards the old worker and its sessions; IndexedDB must supply the model bytes.
  expect(workers.length).toBeGreaterThan(workerCount);
  expect(modelRequests).toHaveLength(3);
});
