import { test, expect } from "@playwright/test";

const JA = "このOCRは国立国会図書館(NDL)が作成した古典籍OCR-LiteおよびCODHのMetomくずし字認識サービスを用いた簡易OCRサービスです。CC BY 4.0で提供されているサービスを元に作られているサービスであることをご了承ください。";
const EN = "This is a simple OCR service that uses Koten OCR-Lite";

test.describe("service notice consent", () => {
  test("shows the ja/en notice first, hides after agree, stays hidden on reload", async ({ page }) => {
    await page.goto("./");
    const dialog = page.locator(".service-notice-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(JA);
    await expect(dialog).toContainText(EN);

    // Centered in the viewport.
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.x).toBeGreaterThan(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThan(120);

    const agree = page.locator(".service-notice-agree");
    await expect(agree).toBeVisible();
    await agree.click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => window.localStorage.getItem("bokkei-service-notice-accepted"))).toBe("true");

    await page.reload();
    await expect(page.locator(".service-notice-dialog")).toHaveCount(0);
  });

  test("reappears on reload without agreeing; escape and backdrop do not accept", async ({ page }) => {
    await page.goto("./");
    const dialog = page.locator(".service-notice-dialog");
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();

    await page.locator(".service-notice-backdrop").click({ position: { x: 5, y: 5 } });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => window.localStorage.getItem("bokkei-service-notice-accepted"))).toBeNull();

    await page.reload();
    await expect(page.locator(".service-notice-dialog")).toBeVisible();
  });

  test("fits a narrow viewport and agrees by keyboard", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("./");
    const dialog = page.locator(".service-notice-dialog");
    await expect(dialog).toBeVisible();

    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);

    const agree = page.locator(".service-notice-agree");
    await expect(agree).toBeVisible();
    await agree.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
  });
});
