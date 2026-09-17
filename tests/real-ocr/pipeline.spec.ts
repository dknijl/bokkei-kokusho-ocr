import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// These tests use the pinned real ONNX models, not the UI test's MockWorker.
const wasmTest = test.extend({ launchOptions: { args: ["--disable-gpu", "--disable-software-rasterizer"] } });
for (const provider of ["wasm", "auto"] as const) {
  const providerTest = provider === "wasm" ? wasmTest : test;
  providerTest(`real dedicated-worker OCR: ${provider}`, async ({ page, context }) => {
    await context.route("https://raw.githubusercontent.com/ndl-lab/ndlkotenocr-lite/**", async route => {
      const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
      await route.fulfill({ path: resolve("work/ocr-evaluation/models", name), headers: { "access-control-allow-origin": "*" } });
    });
    const progress: string[] = [], errors: string[] = [];
    page.on("console", message => { if (message.type() === "error" || message.type() === "warning") errors.push(message.text()); });
    await page.exposeFunction("recordProgress", (value: string) => { progress.push(value); });
    await page.goto("./");
    const reports = [];
    for (const [name, index] of [["manuscript", 0], ["illustrated", 3], ["scroll", 0]] as const) {
      const manifest = JSON.parse(await readFile(`work/ocr-evaluation/${name}-manifest.json`, "utf8"));
      const result = await page.evaluate(async ({ manifest, index }) => {
        const { parseManifest } = await import("/ocr/src/lib/iiif.ts");
        const { executeOcrPage } = await import("/ocr/src/lib/ocr/worker-client.ts");
        const { normalizeNdlOcrOptions } = await import("/ocr/src/lib/ocr/profiles.ts");
        const parsed = parseManifest(manifest, manifest.id ?? manifest["@id"]);
        const target = parsed.pages[index];
        const value = await executeOcrPage(target, normalizeNdlOcrOptions({ profile: "balanced" }), p => {
          (window as any).recordProgress(`${target.canvasId}: ${p.stage} ${p.completed ?? ""}/${p.total ?? ""}`);
        });
        return { ...value, canvasId: target.canvasId, manifestUrl: parsed.url };
      }, { manifest, index });
      expect(result.stats.liveCanvasesAfterPage).toBe(0);
      expect(result.stats.maxCanvasPixels).toBeLessThanOrEqual(2048 * 2048);
      expect(result.stats.extraRecognitionAttempts).toBeLessThanOrEqual(2);
      if (provider === "wasm") expect(result.provider).toBe("WASM");
      if (provider === "auto" && process.env.OCR_REQUIRE_WEBGPU) expect(result.provider).toBe("WebGPU");
      if (name === "scroll") expect(result.stats.sourceTiles).toBeGreaterThan(1);
      else expect(result.lines.length).toBeGreaterThan(0);
      if (name === "manuscript") {
        // Small upper annotations must survive independently of the lower body line.
        // These ranges use original 3744×5616 image coordinates, not Canvas coordinates.
        const notes = result.lines.filter(line => line.region.x > 2700 && line.region.y < 1600);
        const body = result.lines.filter(line => line.region.x > 2700 && line.region.y > 1650);
        expect(notes).toHaveLength(2);
        expect(notes.every(line => line.region.height < 600 && line.text.length > 0)).toBe(true);
        expect(body).toHaveLength(1);
        expect(body[0].text.length).toBeGreaterThan(0);
        expect(result.lines).toHaveLength(14);
      }
      reports.push({ name, result });
      console.log(`${provider} ${name}: ${result.provider}, ${result.lines.length} lines, ${result.stats.sourceTiles} tiles, ${result.stats.durationMs}ms`);
      await writeFile(`work/ocr-evaluation/real-${provider}.json`, JSON.stringify({ requestedProvider: provider, reports, progress, errors }, null, 2));
    }
  });
}
