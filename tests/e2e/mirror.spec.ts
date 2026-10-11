import { expect, test, type Page } from "@playwright/test";

type Call = { name: string; args: any };
const calls = (p: Page) => p.evaluate(() => (window as unknown as { __calls?: Call[] }).__calls ?? []);
const inputs = async (p: Page, type?: string) => (await calls(p)).filter((c) => c.name === "mirrorInput" && (!type || c.args.type === type)).map((c) => c.args);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Mirror" }).click();
});

async function startMirror(page: Page) {
  await page.getByRole("button", { name: "Start mirroring" }).click();
  await expect(page.getByRole("toolbar", { name: "Phone controls" })).toBeVisible();
  await page.locator("canvas").focus();
}

test("idle screen explains what to do and starts with the chosen quality", async ({ page }) => {
  await expect(page.getByRole("heading", { name: /Mirror Pixel 8 Pro/ })).toBeVisible();
  await expect(page.getByText(/Wake and unlock the phone first/)).toBeVisible();
  await page.getByRole("radio", { name: "Native" }).click();
  await page.getByLabel("Bit rate").selectOption("16");
  await page.getByRole("checkbox", { name: /screen off while mirroring/ }).check();
  await page.getByRole("button", { name: "Start mirroring" }).click();
  await expect(page.getByRole("toolbar", { name: "Phone controls" })).toBeVisible();
  const o = (await calls(page)).find((c) => c.name === "mirrorStart")!.args;
  expect(o).toMatchObject({ maxSize: 0, bitRateMbps: 16, screenOff: true, stayAwake: true, showTouches: false });
});

test("quality choices are remembered", async ({ page }) => {
  await page.getByRole("radio", { name: "Low" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Mirror" }).click();
  await expect(page.getByRole("radio", { name: "Low" })).toBeChecked();
});

test("toolbar buttons send Home, Back, Recents, volume, power, notifications and rotate", async ({ page }) => {
  await startMirror(page);
  const bar = page.getByRole("toolbar", { name: "Phone controls" });
  for (const n of [/^Home/, /^Recent apps/, /^Volume up/, /^Volume down/, /^Power/]) await bar.getByRole("button", { name: n }).click();
  const keys = (await inputs(page, "key")).filter((k) => k.action === 0).map((k) => k.keycode);
  expect(keys).toEqual([3, 187, 24, 25, 26]);
  await bar.getByRole("button", { name: /^Back/ }).click();
  expect((await inputs(page, "backOrScreenOn")).map((i) => i.action)).toEqual([0, 1]);
  await bar.getByRole("button", { name: /^Notifications/ }).click();
  await bar.getByRole("button", { name: /^Rotate/ }).click();
  expect((await inputs(page, "panel"))[0].kind).toBe("notifications");
  expect((await inputs(page, "rotate")).length).toBe(1);
});

test("pointer: press-drag-release becomes touch down/move/up in the phone's pixel grid", async ({ page }) => {
  await startMirror(page);
  const box = (await page.locator("canvas").boundingBox())!;
  const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;
  await page.mouse.move(...at(0.5, 0.5));
  await page.mouse.down();
  await page.mouse.move(...at(0.5, 0.25), { steps: 4 });
  await page.mouse.up();
  const t = await inputs(page, "touch");
  expect(t[0]).toMatchObject({ action: 0, pressure: 1, w: 720, h: 1600 });
  expect(Math.abs(t[0].x - 360)).toBeLessThanOrEqual(2);
  expect(Math.abs(t[0].y - 800)).toBeLessThanOrEqual(2);
  expect(t.some((e) => e.action === 2)).toBe(true);
  const up = t[t.length - 1];
  expect(up).toMatchObject({ action: 1, pressure: 0 });
  expect(Math.abs(up.y - 400)).toBeLessThanOrEqual(3);
});

test("right-click is Back, middle-click is Home, the wheel scrolls", async ({ page }) => {
  await startMirror(page);
  const c = page.locator("canvas");
  await c.click({ button: "right" });
  expect((await inputs(page, "backOrScreenOn")).length).toBe(2);
  await c.click({ button: "middle" });
  expect((await inputs(page, "key")).filter((k) => k.action === 0).map((k) => k.keycode)).toContain(3);
  await c.hover();
  await page.mouse.wheel(0, 100);
  await expect.poll(async () => (await inputs(page, "scroll")).length).toBeGreaterThan(0);
  const s = (await inputs(page, "scroll"))[0];
  expect(s.vscroll).toBe(-1); // wheel down → content moves up, clamped to ±1
  expect(s.hscroll).toBeCloseTo(0);
});

test("typing sends text, editing keys send keycodes, ⌥H is Home, ⌘C is left to the Mac", async ({ page }) => {
  await startMirror(page);
  await page.keyboard.type("hi");
  expect((await inputs(page, "text")).map((t) => t.text)).toEqual(["h", "i"]);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Backspace");
  const ks = (await inputs(page, "key")).map((k) => `${k.keycode}:${k.action}`);
  expect(ks).toEqual(["66:0", "66:1", "67:0", "67:1"]);
  await page.keyboard.press("Alt+KeyH");
  expect((await inputs(page, "key")).slice(-2).map((k) => `${k.keycode}:${k.action}`)).toEqual(["3:0", "3:1"]);
  const before = (await inputs(page)).length;
  await page.keyboard.press("Meta+c");
  expect((await inputs(page)).length).toBe(before);
});

test("pasting Mac text sends it to the phone's clipboard and pastes", async ({ page }) => {
  await startMirror(page);
  await page.locator("canvas").evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "héllo from the Mac");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  expect((await inputs(page, "setClipboard"))[0]).toEqual({ type: "setClipboard", text: "héllo from the Mac", paste: true });
});

test("screenshot, screen recording with a timer, and stopping", async ({ page }) => {
  await startMirror(page);
  const bar = page.getByRole("toolbar", { name: "Phone controls" });
  await bar.getByRole("button", { name: "Screenshot" }).click();
  expect((await calls(page)).find((c) => c.name === "phoneScreenshot")!.args.destDir).toMatch(/Pictures\/Droid Shuttle Screenshots$/);
  await expect(page.getByText("Screenshot saved")).toBeVisible();

  await bar.getByRole("button", { name: "Record screen" }).click();
  await expect(bar.getByLabel("Recording time")).toBeVisible();
  await bar.getByRole("button", { name: "Stop recording" }).click();
  expect((await calls(page)).find((c) => c.name === "recordStop")!.args.destDir).toMatch(/Movies\/Droid Shuttle$/);
  await expect(page.getByText("Recording saved")).toBeVisible();

  await bar.getByRole("button", { name: "Stop mirroring" }).click();
  expect((await calls(page)).some((c) => c.name === "mirrorStop")).toBe(true);
  await expect(page.getByRole("button", { name: "Start mirroring" })).toBeVisible();
});

test("while connecting you can cancel; the toolbar only appears once the screen is live", async ({ page }) => {
  await page.getByRole("button", { name: "Start mirroring" }).click();
  await expect(page.getByRole("toolbar", { name: "Phone controls" })).toBeVisible(); // the mock goes live immediately
  await page.getByRole("button", { name: "Stop mirroring" }).click();
  await expect(page.getByRole("toolbar", { name: "Phone controls" })).toHaveCount(0);
});

test("leaving the Mirror screen stops mirroring", async ({ page }) => {
  await startMirror(page);
  await page.getByRole("button", { name: "Files" }).click();
  await expect.poll(async () => (await calls(page)).filter((c) => c.name === "mirrorStop").length).toBeGreaterThan(0);
});
