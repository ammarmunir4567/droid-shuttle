import { expect, test, type Page } from "@playwright/test";

const html = (p: Page) => p.locator("html");
const pick = async (p: Page, name: string) => {
  await p.getByRole("button", { name: "Appearance" }).click();
  await p.getByRole("radio", { name: new RegExp(`^${name}`) }).click();
  await p.keyboard.press("Escape");
};
const accent = (p: Page) => p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim());
const rowHeight = async (p: Page) => (await p.locator("[role=row]", { hasText: "notes.txt" }).first().boundingBox())!.height;

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("nav[aria-label=Sections]");
});

test("Studio is the default: sidebar with a live connection card", async ({ page }) => {
  await expect(html(page)).toHaveAttribute("data-variant", "studio");
  const nav = page.getByRole("navigation", { name: "Sections" });
  await expect(nav).toContainText("Google Pixel 8 Pro");
  await expect(nav).toContainText("Connected by cable");
  await expect(nav).toContainText("57.0 GB free");
  await expect(nav.getByText("Browse")).toBeVisible(); // sentence-case group labels, not ALL CAPS
  expect(await nav.getByText("Browse").evaluate((e) => getComputedStyle(e).textTransform)).toBe("none");
});

test("the picker shows all three looks and marks the current one", async ({ page }) => {
  await page.getByRole("button", { name: "Appearance" }).click();
  const group = page.getByRole("radiogroup", { name: "Look" });
  for (const n of ["Studio", "Instrument", "Soft"]) await expect(group.getByRole("radio", { name: new RegExp(`^${n}`) })).toBeVisible();
  await expect(group.getByRole("radio", { name: /^Studio/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radiogroup", { name: "Brightness" }).getByRole("radio")).toHaveCount(3);
});

test("Instrument: icon rail with tooltips, a status bar, and working navigation", async ({ page }) => {
  await pick(page, "Instrument");
  await expect(html(page)).toHaveAttribute("data-variant", "instrument");
  const rail = page.getByRole("navigation", { name: "Sections" });
  await expect(rail).not.toContainText("Gallery"); // icons only…
  await rail.getByRole("button", { name: "Gallery" }).hover();
  await expect(page.getByRole("tooltip").or(page.getByText("Gallery").last())).toBeVisible(); // …labelled on hover
  const status = page.getByRole("contentinfo", { name: "Phone status" });
  await expect(status).toContainText("Google Pixel 8 Pro");
  await expect(status).toContainText("USB");
  await expect(status).toContainText("82%");
  await rail.getByRole("button", { name: "Apps" }).click();
  await expect(page.getByRole("grid", { name: "Installed apps" })).toBeVisible();
  await expect(rail.getByRole("button", { name: "Apps" })).toHaveAttribute("aria-current", "page");
});

test("Soft: pill tabs, a big title, and a different colour for each area", async ({ page }) => {
  await pick(page, "Soft");
  await expect(html(page)).toHaveAttribute("data-variant", "soft");
  const nav = page.getByRole("navigation", { name: "Sections" });
  for (const n of ["Files", "Gallery", "Apps", "Backup", "Mirror", "Tools"]) await expect(nav.getByRole("button", { name: n })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Files", level: 1 })).toBeVisible();
  const colours = new Set<string>();
  for (const n of ["Files", "Gallery", "Apps", "Backup", "Mirror", "Tools"]) {
    await nav.getByRole("button", { name: n }).click();
    await expect(html(page)).toHaveAttribute("data-section", n.toLowerCase());
    colours.add(await accent(page));
  }
  expect(colours.size).toBe(6);
});

test("the other looks keep one accent for the whole app", async ({ page }) => {
  const nav = page.getByRole("navigation", { name: "Sections" });
  const a1 = await accent(page);
  await nav.getByRole("button", { name: "Gallery" }).click();
  expect(await accent(page)).toBe(a1);
});

test("density differs by look: Instrument is tighter than Studio, Soft is roomier", async ({ page }) => {
  const studio = await rowHeight(page);
  await pick(page, "Instrument");
  const instrument = await rowHeight(page);
  await pick(page, "Soft");
  const soft = await rowHeight(page);
  expect(instrument).toBeLessThan(studio);
  expect(soft).toBeGreaterThan(studio);
});

test("the choice survives a reload, and brightness can be forced", async ({ page }) => {
  await pick(page, "Soft");
  await page.getByRole("button", { name: "Appearance" }).click();
  await page.getByRole("radiogroup", { name: "Brightness" }).getByRole("radio", { name: "Dark" }).click();
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe("rgb(246, 245, 253)"); // not the light lavender any more
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(html(page)).toHaveAttribute("data-variant", "soft");
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Appearance" }).click();
  await page.getByRole("radiogroup", { name: "Brightness" }).getByRole("radio", { name: "Auto" }).click();
  await expect(html(page)).not.toHaveAttribute("data-theme", /.+/);
});

test("the command palette can change the look and brightness", async ({ page }) => {
  await page.keyboard.press("Meta+k");
  await page.getByPlaceholder(/Go to a screen/).fill("instrument");
  await page.getByRole("option", { name: /Look: Instrument/ }).click();
  await expect(html(page)).toHaveAttribute("data-variant", "instrument");
  await page.keyboard.press("Meta+k");
  await page.getByPlaceholder(/Go to a screen/).fill("dark");
  await page.getByRole("option", { name: /Brightness: Dark/ }).click();
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
});

test("no ALL-CAPS labels in any look", async ({ page }) => {
  for (const v of ["Studio", "Instrument", "Soft"]) {
    await pick(page, v);
    const caps = await page.evaluate(() => [...document.querySelectorAll("*")].filter((e) => getComputedStyle(e).textTransform === "uppercase" && e.textContent?.trim()).length);
    expect(caps, v).toBe(0);
  }
});

test("each look's own typeface really loads (bundled, works offline)", async ({ page }) => {
  const loaded = (family: string, weight: number) => page.evaluate(async ([f, w]) => { await document.fonts.load(`${w} 14px "${f}"`); return document.fonts.check(`${w} 14px "${f}"`); }, [family, weight] as const);
  await pick(page, "Instrument");
  expect(await loaded("IBM Plex Sans", 500)).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain("IBM Plex Sans");
  await pick(page, "Soft");
  expect(await loaded("Nunito Variable", 700)).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain("Nunito");
});
