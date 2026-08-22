import { test, expect } from "@playwright/test";

test.describe("OCR workbench browser smoke tests", () => {
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
});
