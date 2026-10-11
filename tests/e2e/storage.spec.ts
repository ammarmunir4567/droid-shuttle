import { expect, test, type Page } from "@playwright/test";

const calls = (p: Page) => p.evaluate(() => (window as unknown as { __calls?: { name: string; args: any }[] }).__calls ?? []);
const named = async (p: Page, n: string) => (await calls(p)).filter((c) => c.name === n);
const map = (p: Page) => p.getByRole("group", { name: "Storage map" });
const status = (p: Page, text: string) => p.getByRole("status").filter({ hasText: text });
const tile = (p: Page, name: string) => map(p).getByRole("button", { name: new RegExp(`^${name},`) });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("[role=row]");
  await page.getByRole("button", { name: "Storage", exact: true }).click();
});

async function scan(page: Page) {
  await page.getByRole("button", { name: "Scan phone storage" }).click();
  await expect(tile(page, "Movies")).toBeVisible();
}

test("explains what a scan does before running it, then shows progress, then the map", async ({ page }) => {
  await expect(page.getByText("See what's using your phone's space")).toBeVisible();
  await expect(page.getByText(/nothing changes/i)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Duplicates" })).toBeDisabled(); // nothing to look at yet
  await page.getByRole("button", { name: "Scan phone storage" }).click();
  await expect(status(page, "Scanning your phone")).toBeVisible();
  await page.evaluate(() => (window as any).__storageProgress({ phase: "scan", files: 41203, bytes: 12_400_000_000, total: 0 }));
  await expect(status(page, "Scanning")).toContainText("41,203 files · 12.4 GB");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(tile(page, "Movies")).toBeVisible(); // finishes
  await expect(status(page, "Scanning")).toHaveCount(0);
  await expect(page.getByText(/Scanned just now/)).toBeVisible();
  await expect(page.getByRole("img", { name: "Storage by file type" })).toBeVisible();
});

test("Stop cancels the scan on the backend", async ({ page }) => {
  await page.getByRole("button", { name: "Scan phone storage" }).click();
  await page.getByRole("button", { name: "Stop" }).click();
  expect(await named(page, "storageCancel")).toHaveLength(1);
});

test("the map sizes tiles by space, and you can drill into folders and back out", async ({ page }) => {
  await scan(page);
  const tiles = await map(page).getByRole("button").all();
  const areas = await Promise.all(tiles.map(async (t) => { const b = (await t.boundingBox())!; return b.width * b.height; }));
  expect(areas[0]).toBeGreaterThan(areas[areas.length - 1] * 3); // biggest first, visibly bigger
  await expect(tile(page, "Movies")).toHaveAttribute("aria-label", /1\.8 GB/);

  await tile(page, "Download").dblclick();
  await expect(page.getByRole("navigation", { name: "Folder path" })).toContainText("Download");
  await expect(tile(page, "big-backup.zip")).toBeVisible();
  await expect(tile(page, "Movies")).toHaveCount(0);

  await page.getByRole("button", { name: "Up one folder" }).click();
  await expect(tile(page, "Movies")).toBeVisible();
  await tile(page, "Android").dblclick();
  await tile(page, "obb").dblclick();
  await page.getByRole("navigation", { name: "Folder path" }).getByRole("button", { name: "Internal storage" }).click();
  await expect(tile(page, "Movies")).toBeVisible();
});

test("selecting a tile shows its details, and Show in Files jumps there", async ({ page }) => {
  await scan(page);
  await tile(page, "Download").click();
  const d = page.getByRole("complementary", { name: "Details" });
  await expect(d).toContainText("Download");
  await expect(d).toContainText("1.2 GB");
  await expect(d).toContainText("4 files");
  await d.getByRole("button", { name: "Show in Files" }).click();
  await expect(page.getByRole("navigation", { name: "Phone path" }).or(page.getByRole("navigation", { name: "Path" })).first()).toContainText("Download");
});

test("deleting a folder from the map asks first, states the size, then updates the totals", async ({ page }) => {
  await scan(page);
  await tile(page, "Download").click();
  await page.getByRole("complementary", { name: "Details" }).getByRole("button", { name: "Delete…" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("Delete “Download” (1.2 GB) from your phone?");
  await expect(dlg).toContainText("can't be undone");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  expect(await named(page, "deviceDelete")).toHaveLength(0); // backing out deletes nothing

  await page.getByRole("complementary", { name: "Details" }).getByRole("button", { name: "Delete…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(async () => (await named(page, "deviceDelete")).length).toBe(1);
  expect((await named(page, "deviceDelete"))[0].args.paths).toEqual(["/sdcard/Download"]);
  await expect(tile(page, "Download")).toHaveCount(0);
  await expect(page.getByText(/Deleted “Download” · freed 1.2 GB/)).toBeVisible();
});

test("clicking a file type opens Large files for it; selecting files totals them and deletes after confirmation", async ({ page }) => {
  await scan(page);
  await page.getByRole("button", { name: /^Videos,/ }).click();
  await expect(page.getByRole("tab", { name: "Large files" })).toHaveAttribute("aria-selected", "true");
  const table = page.getByRole("table", { name: "Largest files" });
  await expect(table.getByRole("row").nth(1)).toContainText("Holiday film.mkv"); // biggest first
  await expect(table.getByRole("row").nth(2)).toContainText("VID_20244.mp4");
  await expect(table).not.toContainText("IMG_");
  await page.getByRole("checkbox", { name: "Select VID_20244.mp4" }).check();
  await page.getByRole("checkbox", { name: "Select VID_20243.mp4" }).check();
  await expect(page.getByText("2 selected · 600.0 MB")).toBeVisible();
  await page.getByRole("button", { name: /^Delete 2 files/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Delete 2 items (600.0 MB) from your phone?");
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(async () => (await named(page, "deviceDelete")).length).toBe(1);
  expect((await named(page, "deviceDelete"))[0].args.paths.sort()).toEqual(["/sdcard/DCIM/Camera/VID_20243.mp4", "/sdcard/DCIM/Camera/VID_20244.mp4"]);
  await expect(table).not.toContainText("VID_20244.mp4");
});

test("the size filter and Select all work", async ({ page }) => {
  await scan(page);
  await page.getByRole("tab", { name: "Large files" }).click();
  const table = page.getByRole("table", { name: "Largest files" });
  await page.getByLabel("Minimum size").selectOption({ label: "1 GB +" });
  await expect(table.getByRole("row")).toHaveCount(1 + 2); // header + Holiday film + big-backup
  await page.getByRole("checkbox", { name: "Select all" }).check();
  await expect(page.getByText(/2 selected · 3\.0 GB/)).toBeVisible();
});

test("duplicates: finds sets, keeps the oldest by default, and always keeps one copy", async ({ page }) => {
  await scan(page);
  await page.getByRole("tab", { name: "Duplicates" }).click();
  await expect(page.getByText("Nothing is deleted until you confirm", { exact: false })).toBeVisible();
  await page.getByLabel("Smallest file to check").selectOption({ label: "1 MB +" });
  await page.getByRole("button", { name: "Find duplicates" }).click();
  await expect(status(page, "Looking for files of the same size")).toBeVisible();
  await page.evaluate(() => (window as any).__storageProgress({ phase: "hash", files: 0, bytes: 3_000_000_000, total: 8_400_000_000 }));
  await expect(status(page, "Checking that copies")).toContainText("3.0 GB of 8.4 GB");

  const sets = page.getByRole("list", { name: "Duplicate sets" });
  await expect(sets.getByRole("listitem").filter({ hasText: "copies ·" })).toHaveCount(3);
  await expect(page.getByText(/3 sets of identical files/)).toBeVisible();
  await expect(page.getByRole("radio", { name: "Keep /sdcard/DCIM/Camera/IMG_20240101.jpg" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Keep /sdcard/Download/IMG_20240101.jpg" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: /^Delete 4 copies · free 13\.0 MB/ })).toBeVisible();

  // Switch the rule: the newest copy of each set is kept instead.
  await page.getByLabel("Which copy to keep").selectOption("newest");
  await expect(page.getByRole("radio", { name: "Keep /sdcard/Download/IMG_20240101.jpg" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Keep /sdcard/Documents/invoice final.pdf" })).toBeChecked();

  // Pick a different keeper by hand, and skip a whole set.
  await page.getByRole("radio", { name: "Keep /sdcard/Documents/invoice (1).pdf" }).check();
  await page.getByRole("checkbox", { name: "Clean up IMG_20240101.jpg" }).uncheck();
  await expect(page.getByRole("button", { name: /^Delete 3 copies/ })).toBeVisible(); // 1 + 2
});

test("duplicates: confirming deletes exactly the unkept copies and clears the finished sets", async ({ page }) => {
  await scan(page);
  await page.getByRole("tab", { name: "Duplicates" }).click();
  await page.getByRole("button", { name: "Find duplicates" }).click();
  await page.getByRole("button", { name: /^Delete 4 copies/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Delete 4 items (13.0 MB) from your phone?");
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(async () => (await named(page, "deviceDelete")).length).toBe(1);
  expect((await named(page, "deviceDelete"))[0].args.paths.sort()).toEqual([
    "/sdcard/Documents/invoice (1).pdf", "/sdcard/Documents/invoice final.pdf", "/sdcard/Download/IMG_20240101.jpg", "/sdcard/Download/IMG_20240201.jpg",
  ]);
  await expect(page.getByText("No duplicates found")).toBeVisible();
  // The originals are still on the phone, so the map still has them.
  await page.getByRole("tab", { name: "Map" }).click();
  await tile(page, "DCIM").dblclick();
  await tile(page, "Camera").dblclick();
  await expect(tile(page, "IMG_20240101.jpg")).toBeVisible();
});
