import { expect, test, type Page } from "@playwright/test";

const calls = (p: Page) => p.evaluate(() => (window as unknown as { __calls?: { name: string; args: any }[] }).__calls ?? []);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Backup" }).click();
  await expect(page.getByRole("heading", { name: /Back up Google Pixel 8 Pro/ })).toBeVisible();
});

test("starts with the recommended folders and apps selected, and explains incremental backups", async ({ page }) => {
  for (const f of ["DCIM", "Pictures", "WhatsApp media", "Download"]) await expect(page.getByRole("checkbox", { name: new RegExp(f) })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Podcasts/ })).not.toBeChecked(); // not recommended
  await expect(page.getByRole("checkbox", { name: /Installed apps/ })).toBeChecked();
  await expect(page.getByText(/never removes anything/)).toBeVisible();
  await expect(page.getByText(/Last backup 3 days ago/)).toBeVisible();
});

test("Back up now sends exactly the selected folders and options", async ({ page }) => {
  await page.getByRole("checkbox", { name: /Pictures/ }).uncheck();
  await page.getByRole("checkbox", { name: /Verify every file/ }).check();
  await page.getByRole("button", { name: "Back up now" }).click();
  const req = (await calls(page)).find((c) => c.name === "backupRun")!.args;
  expect(req).toMatchObject({ serial: "MOCK123", includeApps: true, verify: true, encrypt: false });
  expect(req.folders.sort()).toEqual(["/sdcard/Android/media/com.whatsapp", "/sdcard/DCIM", "/sdcard/Download"]);
  expect(req.destRoot).toMatch(/Droid Shuttle Backups$/);
  await expect(page.getByText(/Backup complete/)).toBeVisible();
});

test("nothing selected disables the button; 'None' and 'Recommended' presets work", async ({ page }) => {
  await page.getByRole("button", { name: "None" }).click();
  await page.getByRole("checkbox", { name: /Installed apps/ }).uncheck();
  await expect(page.getByRole("button", { name: "Back up now" })).toBeDisabled();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /Podcasts/ })).toBeChecked();
  await page.getByRole("button", { name: "Recommended" }).click();
  await expect(page.getByRole("checkbox", { name: /Podcasts/ })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Back up now" })).toBeEnabled();
});

test("encryption needs a matching password of 6+ characters before it can start", async ({ page }) => {
  await page.getByRole("checkbox", { name: /Encrypt this backup/ }).check();
  const go = page.getByRole("button", { name: "Back up now" });
  await expect(go).toBeDisabled();
  await page.getByLabel("Backup password").fill("abc");
  await expect(page.getByText("Use at least 6 characters")).toBeVisible();
  await page.getByLabel("Backup password").fill("correct horse");
  await page.getByLabel("Confirm password").fill("correct hose");
  await expect(page.getByText("Passwords don't match")).toBeVisible();
  await expect(go).toBeDisabled();
  await page.getByLabel("Confirm password").fill("correct horse");
  await expect(go).toBeEnabled();
  await go.click();
  const req = (await calls(page)).find((c) => c.name === "backupRun")!.args;
  expect(req).toMatchObject({ encrypt: true, password: "correct horse" });
});

test("settings survive a reload (except secrets)", async ({ page }) => {
  await page.getByRole("checkbox", { name: /Download/ }).uncheck();
  await page.getByRole("checkbox", { name: /Encrypt this backup/ }).check();
  await page.getByLabel("Backup password").fill("hunter2hunter2");
  await page.reload();
  await page.getByRole("button", { name: "Backup" }).click();
  await expect(page.getByRole("checkbox", { name: /Download/ })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Encrypt this backup/ })).toBeChecked();
  await expect(page.getByLabel("Backup password")).toHaveValue(""); // never persisted
});

test("history lists past backups; Restore opens the contents and sends the chosen folders and apps", async ({ page }) => {
  await expect(page.getByRole("listitem").filter({ hasText: "12.4 GB copied" })).toBeVisible();
  await page.getByRole("button", { name: "Restore…" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("Nothing on the phone is deleted");
  await expect(dlg.getByRole("checkbox", { name: /DCIM/ })).toBeChecked();
  await dlg.getByRole("checkbox", { name: /com.whatsapp/ }).uncheck(); // the WhatsApp media folder
  await dlg.getByRole("button", { name: "All", exact: true }).nth(1).click(); // apps: all
  await dlg.getByRole("radio", { name: /Keep both/ }).click();
  await dlg.getByRole("button", { name: "Restore", exact: true }).click();
  const files = (await calls(page)).find((c) => c.name === "backupRestoreFiles")!.args;
  expect(files).toMatchObject({ folders: ["DCIM"], destBase: "/sdcard", conflict: "keepBoth" });
  expect((await calls(page)).find((c) => c.name === "backupRestoreApps")!.args.dirs).toEqual(["com.whatsapp-2.26"]);
});

test("restore with nothing selected cannot be started", async ({ page }) => {
  await page.getByRole("button", { name: "Restore…" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("button", { name: "None" }).first().click();
  await expect(dlg.getByRole("button", { name: "Nothing selected" })).toBeVisible();
});
