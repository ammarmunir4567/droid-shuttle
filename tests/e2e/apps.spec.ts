import { expect, test, type Page } from "@playwright/test";

const calls = (p: Page) => p.evaluate(() => (window as unknown as { __calls?: { name: string; args: any }[] }).__calls ?? []);
const row = (p: Page, text: string) => p.locator("[role=grid] [role=row]", { hasText: text }).first();

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Apps" }).click();
  await expect(page.getByText("6 apps")).toBeVisible();
});

test("lists user apps by default with filters, counts and a letter-avatar fallback", async ({ page }) => {
  await expect(page.getByRole("radio", { name: /^Apps 6/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /^System 6/ })).toBeVisible();
  await expect(row(page, "WhatsApp")).toContainText("com.whatsapp");
  await page.getByRole("radio", { name: /^System/ }).click();
  await expect(page.getByText("6 apps")).toBeVisible();
  await expect(row(page, "System")).toBeVisible(); // badge
  await page.getByRole("radio", { name: /^Disabled/ }).click();
  await expect(page.locator("[role=grid] [role=row]").first()).toContainText("Disabled");
});

test("search matches names and package ids; sorting by size flips with a second click", async ({ page }) => {
  await page.getByLabel("Search apps").fill("slack");
  await expect(page.getByText("1 app", { exact: true })).toBeVisible();
  await page.getByLabel("Search apps").fill("com.spotify");
  await expect(row(page, "Spotify")).toBeVisible();
  await page.getByLabel("Search apps").fill("");
  await page.getByRole("button", { name: "Size" }).click();
  await expect(page.locator("[role=grid] [role=row]").first()).toContainText("Google Maps"); // biggest first
  await page.getByRole("button", { name: "Size" }).click();
  await expect(page.locator("[role=grid] [role=row]").first()).toContainText("Notes"); // smallest first
});

test("resolves names for apps that don't have one yet, once", async ({ page }) => {
  await page.getByRole("radio", { name: /^System/ }).click();
  await expect.poll(async () => (await calls(page)).filter((c) => c.name === "appsResolve").length).toBeGreaterThan(0);
  const first = (await calls(page)).find((c) => c.name === "appsResolve")!.args;
  expect(first.length).toBeGreaterThan(0);
  expect(first[0]).toHaveProperty("apkPath");
});

test("details panel shows version, sizes and permissions; Open/Force stop call the phone", async ({ page }) => {
  await row(page, "WhatsApp").click();
  const panel = page.getByLabel("App details");
  await expect(panel).toContainText("com.whatsapp");
  await expect(panel).toContainText("Google Play");
  await expect(panel).toContainText("Permissions (2 allowed, 2 denied)");
  await panel.getByRole("button", { name: "Open" }).click();
  await panel.getByRole("button", { name: /Force stop/ }).click();
  const names = (await calls(page)).map((c) => c.name);
  expect(names).toContain("appLaunch");
  expect(names).toContain("appForceStop");
});

test("uninstall asks first, offers to keep data, and sends the choice", async ({ page }) => {
  await row(page, "Zapya").click();
  await page.getByRole("button", { name: /Uninstall…/ }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("Uninstall “Zapya”?");
  await dlg.getByRole("checkbox", { name: /Keep the app's data/ }).check();
  await dlg.getByRole("button", { name: "Uninstall" }).click();
  expect((await calls(page)).find((c) => c.name === "appUninstall")!.args).toEqual({ pkg: "com.dewmobile.kuaiya.play", keepData: true, system: false });
});

test("cancelling the uninstall dialog does nothing; clearing data needs its own confirmation", async ({ page }) => {
  await row(page, "Slack").click();
  await page.getByRole("button", { name: /Uninstall…/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  expect((await calls(page)).filter((c) => c.name === "appUninstall")).toHaveLength(0);
  await page.getByRole("button", { name: "Clear data…" }).click();
  await expect(page.getByRole("dialog")).toContainText("can't be undone");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  expect((await calls(page)).filter((c) => c.name === "appClearData")).toHaveLength(0);
});

test("system apps get a stronger warning and are removed for the user only", async ({ page }) => {
  await page.getByRole("radio", { name: /^System/ }).click();
  await page.locator("[role=grid] [role=row]").first().click();
  await page.getByRole("button", { name: /Remove for this user/ }).click();
  await expect(page.getByRole("dialog")).toContainText("factory reset");
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  expect((await calls(page)).find((c) => c.name === "appUninstall")!.args.system).toBe(true);
});

test("multi-select shows bulk actions and uninstalls each selected app after one confirmation", async ({ page }) => {
  await row(page, "WhatsApp").click();
  await row(page, "Spotify").click({ modifiers: ["Meta"] });
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByRole("button", { name: /Uninstall…/ }).click();
  await expect(page.getByRole("dialog")).toContainText("WhatsApp, Spotify");
  await page.getByRole("dialog").getByRole("button", { name: "Uninstall" }).click();
  await expect.poll(async () => (await calls(page)).filter((c) => c.name === "appUninstall").length).toBe(2);
});
