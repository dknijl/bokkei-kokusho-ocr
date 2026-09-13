import { test, expect } from "@playwright/test";
import { NDL_LATEST_REVISION_URL } from "../../src/lib/ocr/model-source";
import { NDL_MODEL_REVISION } from "../../src/lib/ocr/model-revision";

test.describe("OCR workbench browser smoke tests", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(NDL_LATEST_REVISION_URL, route => route.fulfill({ json: { sha: NDL_MODEL_REVISION } }));
  });
  test("boots with the balanced OCR profile and exposes profile selection", async ({ page }) => {
    await page.goto("http://127.0.0.1:5173/ocr/");

    await expect(page.locator("#ocr-profile")).toHaveValue("balanced");
    await expect(page.locator(".vertical-text")).toBeVisible();

    await page.locator("#ocr-profile").selectOption("accurate");
    await expect(page.locator("#ocr-profile")).toHaveValue("accurate");
    await page.locator("#ocr-profile").selectOption("fast");
    await expect(page.locator("#ocr-profile")).toHaveValue("fast");
  });

  test("reports manifest HTTP failures in the manifest dialog", async ({ page }) => {
    await page.route("https://example.test/broken-manifest", (route) => route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "unavailable" }),
    }));
    await page.goto("http://127.0.0.1:5173/ocr/");
    await page.locator("button.rail-add").click();
    await page.locator("#manifest-url").fill("https://example.test/broken-manifest");
    await page.locator(".manifest-form .load-button").click();

    await expect(page.locator(".manifest-error")).toBeVisible();
  });

  test("keeps the profile control usable on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("./");

    await expect(page.locator(".narrow-pane-switcher")).toBeVisible();
    await expect(page.locator("#ocr-profile")).toBeVisible();
    await page.locator(".narrow-pane-switcher button").nth(1).click();
    await expect(page.locator(".text-panel")).toBeVisible();
  });

  test("cancels page OCR while model loading is pending", async ({ page }) => {
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const manifestUrl = "https://kokusho.nijl.ac.jp/biblio/200021552/manifest";
    const imageService = "https://kokusho.nijl.ac.jp/api/iiif/fixture";
    await page.route(manifestUrl, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        "@id": manifestUrl,
        label: "Browser fixture",
        license: "https://creativecommons.org/publicdomain/mark/1.0/",
        sequences: [{ canvases: [{
          "@id": `${manifestUrl}/canvas/1`,
          label: "1",
          width: 1,
          height: 1,
          images: [{ resource: {
            "@id": `${imageService}/full/1,1/0/default.jpg`,
            service: { "@id": imageService },
          } }],
        }] }],
      }),
    }));
    await page.route(/https:\/\/kokusho\.nijl\.ac\.jp\/.*\/full\/.*\/0\/default\.jpg/, (route) => route.fulfill({
      status: 200,
      contentType: "image/png",
      body: pixel,
    }));
    await page.route(/https:\/\/raw\.githubusercontent\.com\/ndl-lab\/ndlkotenocr-lite\/.+/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.abort().catch(() => undefined);
    });
    await page.goto("http://127.0.0.1:5173/ocr/");
    await page.locator("button.run-full-ocr").click();
    await expect(page.locator("button.cancel-ocr")).toBeVisible({ timeout: 10_000 });
    await page.locator("button.cancel-ocr").click();
    await expect(page.locator("button.run-full-ocr")).toBeVisible({ timeout: 10_000 });
  });

  test("does not load images and shows the license notice when the manifest license is not Creative Commons", async ({ page }) => {
    const manifestUrl = "https://kokusho.nijl.ac.jp/biblio/200021552/manifest";
    const imageService = "https://kokusho.nijl.ac.jp/api/iiif/fixture";
    const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    let fixtureImageRequests = 0;
    await page.route(/https:\/\/kokusho\.nijl\.ac\.jp\/.*\/full\/.*\/0\/default\.jpg/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: pixel }));
    await page.route(`${imageService}/**`, (route) => { fixtureImageRequests++; return route.fulfill({ status: 200, contentType: "image/png", body: pixel }); });
    await page.route(manifestUrl, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        "@id": manifestUrl,
        label: "Restricted fixture",
        license: "https://www.nijl.ac.jp/copyright/",
        sequences: [{ canvases: [{
          "@id": `${manifestUrl}/canvas/1`,
          label: "1",
          width: 1,
          height: 1,
          images: [{ resource: {
            "@id": `${imageService}/full/1,1/0/default.jpg`,
            service: { "@id": imageService },
          } }],
        }] }],
      }),
    }));
    await page.goto("http://127.0.0.1:5173/ocr/");
    await expect(page.locator(".manuscript .license-restricted")).toHaveText("ライセンス上、翻刻利用ができない可能性があります");
    await expect(page.locator(".manuscript img")).toHaveCount(0);
    await expect(page.locator(".page-rail")).toHaveCount(0);
    await expect(page.locator(".viewer-toolbar")).toHaveCount(0);
    await expect(page.locator("button.run-full-ocr")).toHaveCount(0);
    await expect(page.locator(".batch-ocr")).toHaveCount(0);
    await expect(page.locator("button.batch-start")).toHaveCount(0);
    await expect(page.locator(".page-controls")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "一文字OCR" })).toHaveCount(0);
    expect(fixtureImageRequests).toBe(0);

    // Removing the rail and the toolbar must not shift the remaining panes into the rail column.
    const layout = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const stage = box(".image-stage");
      const panel = box(".text-panel");
      const canvas = box(".canvas-wrap");
      return {
        stageX: stage.x, stageWidth: stage.width, stageHeight: stage.height,
        panelX: panel.x,
        canvasHeight: canvas.height,
      };
    });
    expect(layout.stageX).toBe(0);
    expect(layout.stageWidth).toBeGreaterThan(500);
    expect(Math.abs(layout.panelX - (layout.stageX + layout.stageWidth))).toBeLessThanOrEqual(2);
    expect(layout.canvasHeight).toBeGreaterThan(layout.stageHeight * 0.9);

    await page.setViewportSize({ width: 390, height: 844 });
    const narrow = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const switcher = box(".narrow-pane-switcher");
      const stage = box(".image-stage");
      return {
        width: stage.width, y: stage.y, height: stage.height,
        switcherY: switcher.y, switcherHeight: switcher.height,
      };
    });
    expect(narrow.width).toBe(390);
    expect(Math.round(narrow.y)).toBe(Math.round(narrow.switcherY + narrow.switcherHeight));
    expect(narrow.height).toBeGreaterThan(600);
  });
});
