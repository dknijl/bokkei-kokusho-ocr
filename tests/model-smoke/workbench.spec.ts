import { test, expect } from "@playwright/test";
import { HONKOKU_V18_UPSTREAM_COMMIT } from "../../src/lib/ocr/models/manifest.ts";

const modelManifestUrl = process.env.VITE_HONKOKU_MODEL_MANIFEST_URL?.trim() ?? "";
const featureEnabled = process.env.VITE_ENABLE_HONKOKU_V18 === "true";
const smokeIiifManifestUrl = process.env.HONKOKU_SMOKE_IIIF_MANIFEST_URL?.trim() ?? "";

test.describe("Honkoku v18 real-model smoke test", () => {
  test.skip(
    !featureEnabled || !modelManifestUrl,
    "Set VITE_ENABLE_HONKOKU_V18=true and VITE_HONKOKU_MODEL_MANIFEST_URL to run the external-model smoke test.",
  );

  test("validates the manifest and recognizes one real page", async ({ page, request }) => {
    test.setTimeout(10 * 60 * 1000);
    const manifestResponse = await request.get(modelManifestUrl);
    expect(manifestResponse.ok()).toBeTruthy();
    const modelManifest = await manifestResponse.json() as Record<string, unknown>;
    expect(modelManifest.engineId).toBe("honkoku-v18");
    expect(modelManifest.upstreamCommit).toBe(HONKOKU_V18_UPSTREAM_COMMIT);

    let modelManifestRequests = 0;
    page.on("request", (requestEvent) => {
      if (requestEvent.url() === modelManifestUrl) modelManifestRequests += 1;
    });

    await page.goto("./");
    if (smokeIiifManifestUrl) {
      await page.locator("button.rail-add").click();
      await page.locator("#manifest-url").fill(smokeIiifManifestUrl);
      await page.locator(".manifest-form .load-button").click();
      await expect(page.locator(".manifest-dialog")).toBeHidden({ timeout: 30_000 });
    }

    await page.locator("#ocr-engine").selectOption("honkoku-v18");
    await page.locator("button.run-full-ocr").click();
    await expect(page.locator("button.run-full-ocr")).toBeVisible({ timeout: 9 * 60 * 1000 });
    await expect(page.locator(".full-ocr-error")).toHaveCount(0);
    await expect.poll(() => modelManifestRequests).toBeGreaterThan(0);

    const recognizedLines = await page.locator(".vertical-text button[data-line-index]").count();
    expect(recognizedLines).toBeGreaterThan(0);
  });
});
