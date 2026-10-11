import { expect, test, type Page } from "@playwright/test";

const calls = (p: Page) => p.evaluate(() => (window as unknown as { __calls?: { name: string; args: any }[] }).__calls ?? []);
const row = (p: Page, name: string) => p.locator('[role=row]', { hasText: name }).first();

async function drag(p: Page, from: string, to: string | { x: number; y: number }, mods: { alt?: boolean } = {}) {
  const a = (await row(p, from).boundingBox())!;
  await p.mouse.move(a.x + 40, a.y + 10);
  await p.mouse.down();
  await p.mouse.move(a.x + 60, a.y + 30, { steps: 4 });
  let tx: number, ty: number;
  if (typeof to === "string") { const b = (await row(p, to).boundingBox())!; tx = b.x + 40; ty = b.y + 10; } else ({ x: tx, y: ty } = to);
  if (mods.alt) await p.keyboard.down("Alt");
  await p.mouse.move(tx, ty, { steps: 8 });
  return async (release = true) => { if (release) await p.mouse.up(); if (mods.alt) await p.keyboard.up("Alt"); };
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("[role=row]");
});

test("click, ⌘-click and shift-click select rows", async ({ page }) => {
  await row(page, "DCIM").click();
  await row(page, "Music").click({ modifiers: ["Shift"] });
  await expect(page.locator('[role=row][aria-selected=true]')).toHaveCount(3); // DCIM, Download, Music
  await row(page, "notes.txt").click({ modifiers: ["Meta"] });
  await expect(page.locator('[role=row][aria-selected=true]')).toHaveCount(4);
  await expect(page.getByText("4 selected")).toBeVisible();
});

test("dragging a folder onto another moves it, with a live hint", async ({ page }) => {
  const finish = await drag(page, "DCIM", "Download");
  await expect(page.getByText("Move to Download")).toBeVisible();
  await finish();
  const c = (await calls(page)).find((x) => x.name === "startTransfer")!;
  expect(c.args).toMatchObject({ direction: "deviceMove", destDir: "/sdcard/Download", sources: ["/sdcard/DCIM"] });
});

test("⌥ while dragging turns the move into a copy", async ({ page }) => {
  const finish = await drag(page, "DCIM", "Download", { alt: true });
  await expect(page.getByText("Copy to Download")).toBeVisible();
  await finish();
  expect((await calls(page)).find((x) => x.name === "startTransfer")!.args.direction).toBe("deviceCopy");
});

test("Escape cancels a drag; dropping a folder on itself does nothing", async ({ page }) => {
  const finish = await drag(page, "DCIM", "Download");
  await page.keyboard.press("Escape");
  await finish();
  expect(await calls(page)).toHaveLength(0);
  const f2 = await drag(page, "Music", "Music");
  await expect(page.getByText(/Move to|Copy to/)).toHaveCount(0);
  await f2();
  expect(await calls(page)).toHaveLength(0);
});

test("multi-select drag shows a count badge and moves all items", async ({ page }) => {
  await row(page, "Download").click();
  await row(page, "Music").click({ modifiers: ["Meta"] });
  const finish = await drag(page, "Music", "Pictures");
  await expect(page.getByText("2 items")).toBeVisible();
  await finish();
  const c = (await calls(page)).find((x) => x.name === "startTransfer")!;
  expect(c.args.sources.sort()).toEqual(["/sdcard/Download", "/sdcard/Music"]);
});

test("side-by-side Mac pane: phone → Mac is a pull (copy), ⌘ would move", async ({ page }) => {
  await page.getByRole("button", { name: "Show Mac side by side" }).click();
  await expect(page.getByLabel("Mac files")).toBeVisible();
  const mac = (await page.getByLabel("Mac files").boundingBox())!;
  const finish = await drag(page, "IMG_2041.jpg", { x: mac.x + mac.width / 2, y: mac.y + 300 });
  await expect(page.getByText(/^Copy to demo/)).toBeVisible(); // the drag hint, not the function-bar button
  await finish();
  const c = (await calls(page)).find((x) => x.name === "startTransfer")!;
  expect(c.args).toMatchObject({ direction: "pull", destDir: "/Users/demo", sources: ["/sdcard/IMG_2041.jpg"], deleteSource: false });
});

test("Enter renames inline and commits to the backend", async ({ page }) => {
  await row(page, "notes.txt").click();
  await page.keyboard.press("Enter");
  const input = page.getByLabel("Rename");
  await expect(input).toBeFocused();
  await input.fill("todo.txt");
  await input.press("Enter");
  expect((await calls(page)).find((x) => x.name === "deviceRename")!.args).toEqual({ from: "/sdcard/notes.txt", to: "/sdcard/todo.txt" });
});

test("delete from the phone asks for confirmation first", async ({ page }) => {
  await row(page, "notes.txt").click();
  await page.keyboard.press("Delete");
  await expect(page.getByRole("dialog")).toContainText("Delete “notes.txt” from your phone?");
  await page.getByRole("button", { name: "Delete" }).click();
  expect((await calls(page)).find((x) => x.name === "deviceDelete")!.args.paths).toEqual(["/sdcard/notes.txt"]);
});

test("arrow keys move the selection, ⌘A selects all, filter narrows the list", async ({ page }) => {
  await row(page, "DCIM").click();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "Download")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Meta+a");
  await expect(page.getByText("9 selected")).toBeVisible();
  await page.getByLabel("Filter files").fill("mp4");
  await expect(page.locator("[role=row]").filter({ hasText: "Holiday.mp4" })).toHaveCount(1);
  await expect(page.getByText("1 item", { exact: true })).toBeVisible();
});

test("context menu offers file actions", async ({ page }) => {
  await row(page, "Holiday.mp4").click({ button: "right" });
  for (const t of ["Open", "Quick Look", "Save to Mac…", "Rename", "Delete…"]) await expect(page.getByRole("menuitem", { name: new RegExp(t) })).toBeVisible();
});

test.describe("clipboard shortcuts", () => {
  test("⌘C then ⌘V duplicates in place with ' (2)' naming, no click needed on the list", async ({ page }) => {
    await row(page, "notes.txt").click();
    await page.locator("body").click({ position: { x: 5, y: 5 } }); // focus leaves the list entirely
    await page.keyboard.press("Meta+c");
    await expect(page.getByText("Copied 1 item")).toBeVisible();
    await page.keyboard.press("Meta+v");
    await expect.poll(async () => (await calls(page)).find((c) => c.name === "startTransfer")?.args).toMatchObject({
      direction: "deviceCopy", destDir: "/sdcard", sources: ["/sdcard/notes.txt"], conflict: "keepBoth",
    });
  });

  test("⌘X then ⌘V in another folder moves, and cut items are dimmed", async ({ page }) => {
    await row(page, "notes.txt").click();
    await page.keyboard.press("Meta+x");
    await expect(row(page, "notes.txt")).toHaveClass(/opacity-45/);
    await row(page, "Download").dblclick(); // navigate into Download
    await expect(page.getByLabel("Phone files")).toBeVisible();
    await page.keyboard.press("Meta+v");
    await expect.poll(async () => (await calls(page)).find((c) => c.name === "startTransfer")?.args).toMatchObject({
      direction: "deviceMove", destDir: "/sdcard/Download", sources: ["/sdcard/notes.txt"],
    });
  });

  test("⌥⌘V pastes a copy as a move", async ({ page }) => {
    await row(page, "IMG_2041.jpg").click();
    await page.keyboard.press("Meta+c");
    await row(page, "DCIM").dblclick();
    await page.keyboard.press("Alt+Meta+v");
    await expect.poll(async () => (await calls(page)).find((c) => c.name === "startTransfer")?.args.direction).toBe("deviceMove");
  });

  test("phone → Mac pane paste is a pull; ⌘A and ⌘D work", async ({ page }) => {
    await page.getByRole("button", { name: "Show Mac side by side" }).click();
    await row(page, "Holiday.mp4").click();
    await page.keyboard.press("Meta+c");
    await page.getByLabel("Mac files").locator("[role=row]").first().click(); // makes the Mac pane active
    await page.keyboard.press("Meta+v");
    await expect.poll(async () => (await calls(page)).find((c) => c.name === "startTransfer")?.args).toMatchObject({ direction: "pull", destDir: "/Users/demo" });
    await page.keyboard.press("Meta+a");
    await expect(page.getByLabel("Mac files").getByText("9 selected")).toBeVisible();
  });

  test("typing in a text field is left alone", async ({ page }) => {
    await row(page, "notes.txt").click();
    await page.getByLabel("Filter files").click();
    await page.keyboard.type("abc");
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Meta+c");
    expect((await calls(page)).filter((c) => c.name === "startTransfer")).toHaveLength(0);
    await expect(page.getByText("Copied 1 item")).toHaveCount(0);
  });
});

test.describe("copy feedback", () => {
  const toasts = (p: Page) => p.getByRole("status").locator("> div");
  const stageCalls = async (p: Page) => (await calls(p)).filter((c) => c.name === "clipboardStage");

  test("one ⌘C = one job and one toast that turns from “Copying” into “Copied”", async ({ page }) => {
    await row(page, "Holiday.mp4").click();
    await page.keyboard.press("Meta+c");
    await expect(toasts(page)).toHaveCount(1);
    await expect(toasts(page).first()).toContainText("Copied 1 item");
    expect(await stageCalls(page)).toHaveLength(1);
  });

  test("the macOS Copy menu event right after the key press does not copy twice", async ({ page }) => {
    await row(page, "Holiday.mp4").click();
    await page.keyboard.press("Meta+c");
    await page.waitForTimeout(400); // longer than the old 250 ms guard
    await page.evaluate(() => document.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true })));
    await page.keyboard.press("Meta+c");
    expect(await stageCalls(page)).toHaveLength(1);
    await expect(toasts(page)).toHaveCount(1);
  });

  test("copying something different afterwards works normally", async ({ page }) => {
    await row(page, "Holiday.mp4").click();
    await page.keyboard.press("Meta+c");
    await page.waitForTimeout(1700);
    await row(page, "notes.txt").click();
    await page.keyboard.press("Meta+c");
    expect(await stageCalls(page)).toHaveLength(2);
  });

  test("the hidden staging job shows as “Preparing…”, raises no “Finished” toast, and clears itself", async ({ page }) => {
    const snap = (o: object) => ({ id: 77, label: "Preparing 1 item for paste", direction: "pull", status: "running", bytesTotal: 100e6, bytesDone: 40e6, filesTotal: 1, filesDone: 0, filesSkipped: 0, current: "Holiday.mp4", speedBps: 20e6, errors: [], verified: 0, startedMs: 0, finishedMs: null, silent: true, ...o });
    await page.evaluate((s) => (window as any).__emitTransfer(s), snap({}));
    await expect(page.getByRole("region", { name: "Transfers" })).toContainText("Preparing 1 item for paste");
    await page.evaluate((s) => (window as any).__emitTransfer(s), snap({ status: "done", bytesDone: 100e6, filesDone: 1, finishedMs: 5 }));
    await page.waitForTimeout(300);
    await expect(page.getByText(/Finished/)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Transfers" })).toHaveCount(0, { timeout: 4000 }); // row removed → tray gone
  });

  test("a normal transfer still gets its “Finished” toast", async ({ page }) => {
    const base = { id: 78, label: "Holiday.mp4", direction: "pull", status: "running", bytesTotal: 10, bytesDone: 5, filesTotal: 1, filesDone: 0, filesSkipped: 0, current: null, speedBps: 0, errors: [], verified: 0, startedMs: 0, finishedMs: null };
    await page.evaluate((s) => (window as any).__emitTransfer(s), base);
    await page.evaluate((s) => (window as any).__emitTransfer(s), { ...base, status: "done", bytesDone: 10, filesDone: 1, finishedMs: 9 });
    await expect(page.getByText(/Finished “Holiday.mp4”/)).toBeVisible();
  });
});
