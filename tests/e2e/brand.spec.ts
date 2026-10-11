import { expect, test, type Page } from "@playwright/test";

const pick = async (p: Page, name: string) => {
  await p.getByRole("button", { name: "Appearance" }).click();
  await p.getByRole("radio", { name: new RegExp(`^${name}`) }).click();
  await p.keyboard.press("Escape");
};

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("nav[aria-label=Sections]");
});

test("the app is called Droid Shuttle: tab title and favicon", async ({ page }) => {
  await expect(page).toHaveTitle("Droid Shuttle");
  expect(await page.locator('link[rel="icon"]').getAttribute("href")).toBe("/logo.svg");
  expect((await page.request.get("/logo.svg")).ok()).toBe(true);
});

test("the logo and name appear in every layout", async ({ page }) => {
  const logo = page.getByRole("img", { name: "Droid Shuttle" });
  await expect(logo.first()).toBeVisible();                    // Studio: lockup beside the traffic lights
  await expect(page.getByText("Droid Shuttle").first()).toBeVisible();
  await pick(page, "Instrument");
  await expect(logo.first()).toBeVisible();                    // Instrument: top strip
  await expect(page.getByText("Droid Shuttle").first()).toBeVisible();
  await pick(page, "Soft");
  await expect(logo.first()).toBeVisible();                    // Soft: beside the pill tabs
});

test("the appearance menu carries the brand and says it's free and open source", async ({ page }) => {
  await page.getByRole("button", { name: "Appearance" }).click();
  await expect(page.getByRole("dialog", { name: "Appearance" })).toContainText("Droid Shuttle");
  await expect(page.getByRole("dialog", { name: "Appearance" })).toContainText("free and open source");
});

test("the logo uses the brand colours", async ({ page }) => {
  const fills = await page.getByRole("img", { name: "Droid Shuttle" }).first().evaluate((svg) => [...svg.querySelectorAll("[fill],[stroke]")].map((e) => (e.getAttribute("fill") ?? e.getAttribute("stroke") ?? "").toLowerCase()));
  for (const c of ["#0f1b2d", "#ff6b4a", "#2f6bea", "#f4f6fa", "#7fa6ff"]) expect(fills).toContain(c);
});

test("a coral shuttle rides at the head of a running transfer's progress bar, and not on finished ones", async ({ page }) => {
  const snap = (o: object) => ({ id: 5, label: "Holiday.mp4", direction: "push", status: "running", bytesTotal: 100, bytesDone: 40, filesTotal: 1, filesDone: 0, filesSkipped: 0, current: null, speedBps: 10, errors: [], verified: 0, startedMs: 0, finishedMs: null, ...o });
  await page.evaluate((s) => (window as any).__emitTransfer(s), snap({}));
  const tray = page.getByRole("region", { name: "Transfers" });
  const head = tray.locator("li svg path[fill='#FF6B4A']");
  await expect(head).toHaveCount(1);
  await page.evaluate((s) => (window as any).__emitTransfer(s), snap({ status: "done", bytesDone: 100, filesDone: 1, finishedMs: 9 }));
  await expect(tray.locator("li svg path[fill='#FF6B4A']")).toHaveCount(0);
});

test("the first-run screen shows the logo", async ({ page }) => {
  await page.evaluate(async () => { const m = await import("/src/store/devices.ts"); m.useDevices.getState().setDevices([]); });
  await expect(page.getByRole("heading", { name: "Connect your Android phone" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Droid Shuttle" }).last()).toBeVisible();
  await expect(page.getByText("Free, open-source Android ⇄ Mac manager")).toBeVisible();
});

test("no trace of the old name is shown anywhere", async ({ page }) => {
  for (const v of ["Studio", "Instrument", "Soft"]) {
    await pick(page, v);
    for (const s of ["Files", "Gallery", "Apps", "Backup", "Mirror", "Tools"]) {
      await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: s }).click();
      expect((await page.locator("body").innerText()).toLowerCase(), `${v}/${s}`).not.toContain("droidbridge");
    }
  }
});
