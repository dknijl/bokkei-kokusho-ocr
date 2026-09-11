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
    // The engine is exposed through this API; the production UI still uses NDL.
    const result = await page.evaluate(async ({ modelManifestUrl, smokeIiifManifestUrl }) => {
      const { initialManifest, parseManifest } = await import("/ocr/src/lib/iiif.ts");
      const { recognizePage } = await import("/ocr/src/lib/page-ocr.ts");
      const url = smokeIiifManifestUrl || initialManifest.url;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`IIIF manifest HTTP ${response.status}`);
      const manifest = parseManifest(await response.json(), url);
      return recognizePage(manifest.pages[0], { engineId: "honkoku-v18", modelManifestUrl });
    }, { modelManifestUrl, smokeIiifManifestUrl });
    await expect.poll(() => modelManifestRequests).toBeGreaterThan(0);
    expect(result.engineId).toBe("honkoku-v18");
    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.lines.every(line => line.rawKoji !== undefined)).toBe(true);
  });
});
