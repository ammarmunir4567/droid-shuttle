import { expect, test, type Page } from "@playwright/test";

const calls = (p: Page) => p.evaluate(() => (window as unknown as { __calls?: { name: string; args: any }[] }).__calls ?? []);
const tiles = (p: Page) => p.locator("[role=gridcell]");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Gallery" }).click();
  await expect(page.getByText("600 items")).toBeVisible();
});

test("groups photos by day with newest first, and can switch to months", async ({ page }) => {
  const heads = page.getByRole("heading", { level: 2 });
  await expect(heads.first()).toContainText("2026");
  const dayCount = await heads.count();
  await page.getByRole("radio", { name: "month" }).click();
  expect(await heads.count()).toBeLessThan(dayCount);
  await expect(heads.first()).toHaveText(/^[A-Z][a-z]+ 2026$/);
});

test("filters by type, album and 'new only'", async ({ page }) => {
  await page.getByRole("button", { name: /^Videos/ }).click();
  await expect(page.getByText(/^\d+ items$/).first()).not.toHaveText("600 items");
  await page.getByRole("button", { name: /^All\s/ }).first().click();
  await page.getByRole("button", { name: /^Camera/ }).last().click(); // album
  await expect(page.getByText("150 items")).toBeVisible();
  await page.getByRole("button", { name: /New only/ }).click();
  await expect(page.getByText(/^1[0-3]\d items$/)).toBeVisible(); // imported ones (every 7th) are hidden
});

test("selection: click, shift-range, ⌘A, group header; summary bar and import label update", async ({ page }) => {
  await tiles(page).nth(0).click();
  await expect(page.getByText("1 selected")).toBeVisible();
  await tiles(page).nth(3).click({ modifiers: ["Shift"] });
  await expect(page.getByText("4 selected")).toBeVisible();
  await expect(page.getByRole("button", { name: "Import 4" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("selected")).toHaveCount(0);
  await page.locator("[role=grid]").focus();
  await page.keyboard.press("Meta+a");
  await expect(page.getByText("600 selected")).toBeVisible();
});

test("import dialog: sensible defaults, delete-after is opt-in and warns, sends the right request", async ({ page }) => {
  await tiles(page).nth(0).click();
  await tiles(page).nth(2).click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "Import 3" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("Import 3 items");
  await expect(dlg.getByRole("radio", { name: /By month/ })).toHaveAttribute("aria-checked", "true");
  const del = dlg.getByRole("checkbox");
  await expect(del).not.toBeChecked();
  await del.check();
  await expect(dlg).toContainText("Android has no Trash");
  await expect(dlg.getByRole("button", { name: "Import and delete" })).toBeVisible();
  await del.uncheck();
  await dlg.getByRole("radio", { name: /By album/ }).click();
  await dlg.getByRole("button", { name: "Import", exact: true }).click();
  const c = (await calls(page)).find((x) => x.name === "mediaImport")!;
  expect(c.args).toMatchObject({ organize: "album", deleteAfter: false });
  expect(c.args.items).toHaveLength(3);
  expect(c.args.destDir).toMatch(/Pictures\/Droid Shuttle$/);
});

test("delete-after is never remembered between imports", async ({ page }) => {
  await tiles(page).nth(0).click();
  await page.getByRole("button", { name: "Import 1" }).click();
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Import 1" }).click();
  await expect(page.getByRole("dialog").getByRole("checkbox")).not.toBeChecked();
});

test("viewer: open, navigate with arrows, toggle info, close with Escape", async ({ page }) => {
  await tiles(page).nth(1).dblclick();
  const viewer = page.getByRole("dialog");
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText("2 of 600");
  await page.keyboard.press("ArrowRight");
  await expect(viewer).toContainText("3 of 600");
  await page.keyboard.press("ArrowLeft");
  await expect(viewer).toContainText("2 of 600"); // a photo (item 1 is a video — EXIF is photo-only)
  await page.keyboard.press("i");
  await expect(page.getByLabel("Details")).toContainText("Dimensions");
  await expect(page.getByLabel("Details")).toContainText("Google Pixel 8 Pro"); // EXIF camera
  await expect(page.getByRole("button", { name: /Show location in Maps/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
});

test("thumbnail size slider resizes the grid", async ({ page }) => {
  const before = (await tiles(page).first().boundingBox())!.width;
  await page.getByLabel("Thumbnail size").fill("250");
  await expect.poll(async () => (await tiles(page).first().boundingBox())!.width).toBeGreaterThan(before + 40);
});

test("sidebar only offers features that work over a plain USB cable (no companion-app sections)", async ({ page }) => {
  const nav = page.getByRole("navigation", { name: "Sections" });
  for (const gone of ["Contacts", "Messages", "Call Log"]) await expect(nav.getByRole("button", { name: gone })).toHaveCount(0);
  for (const kept of ["Files", "Gallery"]) await expect(nav.getByRole("button", { name: kept })).toBeVisible();
});

test.describe("viewer shows the whole photo, never cropped or zoomed", () => {
  // Geometry of the displayed image relative to the pane that holds it.
  const geometry = (p: Page) => p.evaluate(() => {
    const img = document.querySelector<HTMLImageElement>('[role=dialog] img[alt]')!;
    const pane = img.parentElement!.getBoundingClientRect();
    const r = img.getBoundingClientRect();
    // Where the picture itself lands inside the <img> box (object-fit: contain), in screen pixels.
    const nat = { w: img.naturalWidth, h: img.naturalHeight };
    const k = Math.min(r.width / nat.w, r.height / nat.h);
    const [dw, dh] = [nat.w * k, nat.h * k];
    const [cx, cy] = [r.left + r.width / 2, r.top + r.height / 2];
    return { pane: { l: pane.left, t: pane.top, r: pane.right, b: pane.bottom }, shown: { l: cx - dw / 2, t: cy - dh / 2, r: cx + dw / 2, b: cy + dh / 2, ratio: dw / dh }, nat: { ratio: nat.w / nat.h }, box: { w: r.width, h: r.height } };
  });
  const open = async (p: Page, name: string) => {
    await p.locator(`[role=gridcell][aria-label="${name}"]`).dblclick();
    await expect(p.locator("[role=dialog] img[alt]")).toBeVisible();
    await p.waitForFunction(() => (document.querySelector("[role=dialog] img[alt]") as HTMLImageElement)?.naturalWidth > 0);
  };
  const fits = (g: Awaited<ReturnType<typeof geometry>>) => {
    expect(g.shown.l).toBeGreaterThanOrEqual(g.pane.l - 1);
    expect(g.shown.t).toBeGreaterThanOrEqual(g.pane.t - 1);
    expect(g.shown.r).toBeLessThanOrEqual(g.pane.r + 1);
    expect(g.shown.b).toBeLessThanOrEqual(g.pane.b + 1);
    expect(g.shown.ratio).toBeCloseTo(g.nat.ratio, 2); // keeps its true shape
  };

  test("a portrait photo fits inside the pane instead of overflowing it", async ({ page }) => {
    await open(page, "IMG_0002.jpg"); // portrait (3000 × 4000)
    const g = await geometry(page);
    expect(g.nat.ratio).toBeCloseTo(0.75, 2);
    fits(g);
  });

  test("a landscape photo fits too, at every window size", async ({ page }) => {
    for (const [w, h] of [[1280, 800], [900, 600], [1600, 700]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await open(page, "IMG_0001.jpg"); // landscape (4000 × 3000)
      fits(await geometry(page));
      await page.keyboard.press("Escape");
    }
  });

  test("navigating between a portrait and a landscape photo re-fits each one", async ({ page }) => {
    await open(page, "IMG_0001.jpg");
    fits(await geometry(page));
    await page.keyboard.press("ArrowRight"); // IMG_0002 is portrait
    await page.waitForFunction(() => (document.querySelector("[role=dialog] img[alt]") as HTMLImageElement)?.naturalHeight > 1900);
    const g = await geometry(page);
    expect(g.nat.ratio).toBeLessThan(1);
    fits(g);
  });

  test("starts un-zoomed, and double-click zoom can be undone", async ({ page }) => {
    await open(page, "IMG_0002.jpg");
    const scale = () => page.locator("[role=dialog] img[alt]").evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).a);
    expect(await scale()).toBe(1);
    await page.locator("[role=dialog] img[alt]").dblclick();
    expect(await scale()).toBeGreaterThan(1);
    await page.locator("[role=dialog] img[alt]").dblclick();
    expect(await scale()).toBe(1);
  });
});
