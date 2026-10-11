import { expect, test, type Page } from "@playwright/test";

const calls = (p: Page) => p.evaluate(() => (window as unknown as { __calls?: { name: string; args: any }[] }).__calls ?? []);
const transfers = async (p: Page) => (await calls(p)).filter((c) => c.name === "startTransfer").map((c) => c.args);
const pane = (p: Page, side: "device" | "local") => p.locator(`section[data-pane="${side}"]`);
const row = (p: Page, side: "device" | "local", name: string) => pane(p, side).locator("[role=row]", { hasText: name }).first();

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("[role=row]");
  await page.getByRole("button", { name: "Show Mac side by side" }).click();
  await expect(pane(page, "local")).toBeVisible();
});

test("two panes each get their own path bar and navigate independently", async ({ page }) => {
  await expect(page.getByRole("navigation", { name: "Phone path" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Mac path" })).toBeVisible();
  await row(page, "device", "DCIM").dblclick();
  await expect(page.getByRole("navigation", { name: "Phone path" })).toContainText("DCIM");
  await expect(page.getByRole("navigation", { name: "Mac path" })).not.toContainText("DCIM");
  // Back in the phone pane only rewinds the phone pane.
  await page.getByRole("navigation", { name: "Phone path" }).locator("xpath=preceding-sibling::button[3]").click();
  await expect(page.getByRole("navigation", { name: "Phone path" })).not.toContainText("DCIM");
});

test("F5 copies the active pane's selection into the other pane's folder, F6 moves it", async ({ page }) => {
  await row(page, "device", "notes.txt").click();
  await page.keyboard.press("F5");
  await expect.poll(async () => (await transfers(page)).length).toBe(1);
  expect((await transfers(page))[0]).toMatchObject({ direction: "pull", sources: ["/sdcard/notes.txt"], destDir: "/Users/demo", deleteSource: false });

  await page.keyboard.press("F6");
  await expect.poll(async () => (await transfers(page)).length).toBe(2);
  expect((await transfers(page))[1]).toMatchObject({ direction: "pull", deleteSource: true });

  // From the Mac pane it goes the other way, into the phone pane's current folder.
  await row(page, "local", "Holiday.mp4").click();
  await page.keyboard.press("F5");
  await expect.poll(async () => (await transfers(page)).length).toBe(3);
  expect((await transfers(page))[2]).toMatchObject({ direction: "push", sources: ["/Users/demo/Holiday.mp4"], destDir: "/sdcard" });
});

test("the function bar mirrors the keys, names the destination, and is disabled with nothing selected", async ({ page }) => {
  const bar = page.getByRole("toolbar", { name: "Two-pane actions" });
  await expect(bar.getByRole("button", { name: "Copy to Mac" })).toBeDisabled();
  await expect(bar.getByRole("button", { name: "Delete" })).toBeDisabled();
  await row(page, "device", "backup.zip").click();
  await bar.getByRole("button", { name: "Copy to Mac" }).click();
  await expect.poll(async () => (await transfers(page)).length).toBe(1);
  await row(page, "local", "notes.txt").click();
  await expect(bar.getByRole("button", { name: "Copy to phone" })).toBeEnabled();
  await bar.getByRole("button", { name: "Move to phone" }).click();
  await expect.poll(async () => (await transfers(page)).length).toBe(2);
  expect((await transfers(page))[1]).toMatchObject({ direction: "push", deleteSource: true });
});

test("F5 with nothing selected explains itself instead of doing nothing silently", async ({ page }) => {
  await pane(page, "device").focus();
  await page.keyboard.press("F5");
  await expect(page.getByText("Select something in the active pane first")).toBeVisible();
  expect(await transfers(page)).toHaveLength(0);
});

test("Tab moves between panes, and the active pane is the one actions apply to", async ({ page }) => {
  await row(page, "device", "notes.txt").click();
  await page.keyboard.press("Tab");
  await expect(pane(page, "local")).toBeFocused();
  await expect(page.getByRole("toolbar", { name: "Two-pane actions" }).getByRole("button", { name: "Copy to phone" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(pane(page, "device")).toBeFocused();
  await expect(page.getByRole("toolbar", { name: "Two-pane actions" }).getByRole("button", { name: "Copy to Mac" })).toBeVisible();
});

test("F7 makes a folder and F8 asks before deleting from the phone", async ({ page }) => {
  await row(page, "device", "notes.txt").click();
  await page.keyboard.press("F7");
  await expect.poll(async () => (await calls(page)).some((c) => c.name === "deviceMkdir" && c.args.path === "/sdcard/untitled folder")).toBe(true);
  await row(page, "device", "notes.txt").click();
  await page.keyboard.press("F8");
  await expect(page.getByRole("dialog")).toContainText("Delete “notes.txt” from your phone?");
  await page.getByRole("button", { name: "Delete", exact: true }).last().click();
  await expect.poll(async () => (await calls(page)).some((c) => c.name === "deviceDelete")).toBe(true);
});

test("⌘U swaps the panes and the choice is remembered", async ({ page }) => {
  const x = async (side: "device" | "local") => (await pane(page, side).boundingBox())!.x;
  expect(await x("device")).toBeLessThan(await x("local"));
  await row(page, "device", "notes.txt").click();
  await page.keyboard.press("Meta+u");
  expect(await x("local")).toBeLessThan(await x("device"));
  // Selection survives the swap, and so does the layout after a reload.
  await expect(row(page, "device", "notes.txt")).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await page.waitForSelector("[role=row]");
  expect(await x("local")).toBeLessThan(await x("device"));
});

test("the divider resizes the panes with the mouse and the keyboard, and double-click centres it", async ({ page }) => {
  const sep = page.getByRole("separator", { name: "Resize panes" });
  await expect(sep).toHaveAttribute("aria-valuenow", "50");
  const box = (await sep.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 261, box.y + 200, { steps: 6 });
  await page.mouse.up();
  const dragged = Number(await sep.getAttribute("aria-valuenow"));
  expect(dragged).toBeGreaterThan(55);
  await sep.focus();
  await page.keyboard.press("ArrowLeft");
  expect(Number(await sep.getAttribute("aria-valuenow"))).toBeLessThan(dragged);
  await sep.dblclick();
  await expect(sep).toHaveAttribute("aria-valuenow", "50");
  // Never so far that a pane disappears.
  await sep.focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowRight");
  await expect(sep).toHaveAttribute("aria-valuenow", "75");
});

test("the right-click menu offers copy and move to the other pane", async ({ page }) => {
  await row(page, "device", "notes.txt").click({ button: "right" });
  await page.getByRole("menuitem", { name: /Move to Mac pane/ }).click();
  await expect.poll(async () => (await transfers(page)).length).toBe(1);
  expect((await transfers(page))[0]).toMatchObject({ direction: "pull", deleteSource: true });
});
