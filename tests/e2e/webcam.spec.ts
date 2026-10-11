import { expect, test, type Page } from "@playwright/test";

type Call = { name: string; args: any };
const calls = (p: Page) => p.evaluate(() => (window as unknown as { __calls?: Call[] }).__calls ?? []);
const named = async (p: Page, name: string) => (await calls(p)).filter((c) => c.name === name);
const emit = (p: Page, ev: "level" | "ended", payload: unknown) => p.evaluate(([e, v]) => (window as unknown as { __webcamEmit: (a: string, b: unknown) => void }).__webcamEmit(e as string, v), [ev, payload] as const);

/** Fresh storage, optional mock flags (prerequisites / failures), then open the Webcam screen. */
async function open(page: Page, flags?: Record<string, unknown>) {
  await page.goto("/");
  await page.evaluate((f) => { localStorage.clear(); if (f) localStorage.setItem("db.mock.webcam", JSON.stringify(f)); }, flags ?? null);
  await page.reload();
  await goWebcam(page);
}
const nav = (p: Page, name: string) => p.getByRole("navigation", { name: "Sections" }).getByRole("button", { name, exact: true });
const goWebcam = async (p: Page) => { await nav(p, "Webcam").click(); await expect(p.getByRole("heading", { name: /as a webcam/ })).toBeVisible(); };
const camera = (p: Page) => p.getByRole("combobox", { name: "Camera", exact: true });
const start = (p: Page) => p.getByRole("button", { name: "Start webcam" });
const stop = (p: Page) => p.getByRole("button", { name: "Stop webcam" });

test("the idle screen explains the job and finds OBS and BlackHole", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("heading", { name: "Use Pixel 8 Pro as a webcam" })).toBeVisible();
  await expect(page.getByText("Found", { exact: true })).toHaveCount(2);
  await expect(page.getByText("brew install --cask obs")).toHaveCount(0); // nothing to install
  await expect(start(page)).toBeEnabled();
  await expect(page.getByRole("group", { name: "Camera preview" })).toContainText("appears here once the webcam is on");
});

test("missing OBS and BlackHole show how to install them, with copy buttons and a Re-check", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:5199" });
  await open(page, { obsInstalled: false, blackholeInstalled: false });
  await expect(page.getByText("Not found", { exact: true })).toHaveCount(2);
  await expect(page.getByText("brew install --cask obs", { exact: true })).toBeVisible();
  await expect(page.getByText("brew install --cask blackhole-2ch", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Copy BlackHole 2ch install command" }).click();
  await expect(page.getByRole("button", { name: "Copied BlackHole 2ch install command" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("brew install --cask blackhole-2ch");
  // …and the mic section says what that means for Zoom/Meet
  await expect(page.getByRole("note")).toContainText("BlackHole isn't installed");

  const before = (await named(page, "webcamPrereqs")).length;
  await page.evaluate(() => localStorage.setItem("db.mock.webcam", JSON.stringify({ obsInstalled: true, blackholeInstalled: true })));
  await page.getByRole("button", { name: "Re-check" }).click();
  await expect(page.getByText("Found", { exact: true })).toHaveCount(2);
  expect((await named(page, "webcamPrereqs")).length).toBeGreaterThan(before);
  await expect(page.getByText("brew install --cask obs")).toHaveCount(0);
});

test("a phone older than Android 12 can't use the camera: clear message, Start is disabled", async ({ page }) => {
  await open(page, { sdk: 30, cameraSupported: false });
  await expect(page.getByRole("alert")).toContainText("Camera needs Android 12 or newer. This phone runs Android 11.");
  await expect(start(page)).toBeDisabled();
});

test("without Android 11 the mic is switched off and the camera still starts (mic: false)", async ({ page }) => {
  await open(page, { sdk: 29, micSupported: false });
  await expect(page.getByText("Microphone capture needs Android 11 or newer")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /microphone too/ })).toBeDisabled();
  await start(page).click();
  await expect(stop(page)).toBeVisible();
  expect((await named(page, "webcamStart"))[0].args.mic).toBe(false);
});

test("the camera list comes from the phone; picking the front camera starts it by id", async ({ page }) => {
  await open(page);
  const sel = camera(page);
  await expect(sel.locator("option")).toHaveText(["Back camera (4000×3000)", "Front camera (1920×1080)"]);
  await expect(sel).toHaveValue("0"); // default: the rear camera
  await sel.selectOption({ label: "Front camera (1920×1080)" });
  await start(page).click();
  await expect(stop(page)).toBeVisible();
  expect((await named(page, "webcamStart"))[0].args).toMatchObject({ cameraId: "1", facing: "front" });
});

test("if the camera list can't be read, Front/Back buttons take over", async ({ page }) => {
  await open(page, { camerasFail: true });
  await expect(page.getByText("Couldn't list this phone's cameras")).toBeVisible();
  await expect(page.getByRole("radio", { name: "Back" })).toBeChecked();
  await page.getByRole("radio", { name: "Front" }).click();
  await start(page).click();
  await expect(stop(page)).toBeVisible();
  expect((await named(page, "webcamStart"))[0].args).toMatchObject({ cameraId: "", facing: "front" });
});

test("Start sends exactly what was chosen (720p, 24 fps, rotation, mic type, delay, port)", async ({ page }) => {
  await open(page);
  await page.getByRole("radio", { name: "720p" }).click();
  await page.getByRole("radio", { name: "24 fps" }).click();
  await page.getByRole("radio", { name: "90°" }).click();
  await page.getByLabel("Microphone type").selectOption("mic-voice-communication");
  await page.getByRole("slider", { name: "Mic delay" }).fill("250");
  await expect(page.getByText("250 ms")).toBeVisible();
  await page.getByText("Advanced").click();
  await page.getByLabel("Bit rate").selectOption("8");
  await page.getByLabel("OBS port").fill("5411");
  await start(page).click();
  await expect(stop(page)).toBeVisible();
  expect((await named(page, "webcamStart"))[0].args).toEqual({
    cameraId: "0", facing: "back", width: 1280, height: 720, fps: 24, bitRateMbps: 8, rotation: 90,
    mic: true, micSource: "mic-voice-communication", audioDelayMs: 250, outputDevice: "", port: 5411,
  });
  await expect(page.getByText("tcp://127.0.0.1:5411", { exact: true })).toBeVisible();
});

test("the choices are remembered, and a damaged saved value falls back to defaults", async ({ page }) => {
  await open(page);
  await page.getByRole("radio", { name: "720p" }).click();
  await page.getByRole("checkbox", { name: /microphone too/ }).uncheck();
  await page.reload();
  await goWebcam(page);
  await expect(page.getByRole("radio", { name: "720p" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /microphone too/ })).not.toBeChecked();

  await page.evaluate(() => localStorage.setItem("db.webcam.opts", JSON.stringify({ width: "huge", fps: 60, rotation: 7, micSource: "x" })));
  await page.reload();
  await goWebcam(page);
  await expect(page.getByRole("radio", { name: "1080p" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "30 fps" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "0°", exact: true })).toBeChecked();
});

test("while the webcam is on: OBS address, live status and meter, and the settings are locked", async ({ page }) => {
  await open(page);
  await expect(page.getByText("tcp://127.0.0.1:5400", { exact: true })).toBeVisible(); // shown before starting too
  await expect(page.getByRole("meter")).toHaveCount(0);
  await start(page).click();
  await expect(stop(page)).toBeVisible();
  await expect(page.getByRole("group", { name: "Camera preview" })).toContainText("Live · 1080p · 30 fps · mic on");
  await expect(page.getByRole("radio", { name: "720p" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: /microphone too/ })).toBeDisabled();
  await expect(page.getByText("Stop the webcam to change the camera and microphone settings")).toBeVisible();
  await expect(page.getByText(/playing to BlackHole 2ch/)).toBeVisible();

  // Lip-sync is tuned while watching yourself in OBS, so the mic delay stays live and is sent to the backend.
  const delay = page.getByRole("slider", { name: "Mic delay" });
  await expect(delay).toBeEnabled();
  expect(await named(page, "webcamSetDelay")).toHaveLength(0);
  await delay.fill("300");
  await expect.poll(async () => (await named(page, "webcamSetDelay")).map((c) => c.args)).toContainEqual({ delayMs: 300 });
  await expect(page.getByText("300 ms")).toBeVisible();

  const meter = page.getByRole("meter", { name: "Microphone level" });
  await expect(meter).toHaveAttribute("aria-valuenow", "0");
  await emit(page, "level", 0.5);
  await expect(meter).toHaveAttribute("aria-valuenow", "0.5");
  const fill = await meter.locator("div").evaluate((el) => (el as HTMLElement).style.width);
  expect(parseInt(fill)).toBeGreaterThan(80); // 0.5 RMS ≈ −6 dB → nearly full on the dB scale
  // OBS recipe is on screen, with the URL in the first step
  await expect(page.getByRole("list").filter({ hasText: "Start Virtual Camera" }).getByRole("listitem")).toHaveCount(4);
  await expect(page.getByText(/choose the camera “OBS Virtual Camera”/)).toBeVisible();
  await expect(page.getByText(/Choose the microphone “BlackHole 2ch”/)).toBeVisible();
});

test("the webcam keeps running when you leave the screen, and the preview re-attaches when you return", async ({ page }) => {
  await open(page);
  await start(page).click();
  await expect(stop(page)).toBeVisible();
  expect((await named(page, "webcamAttachPreview")).length).toBe(1);

  await nav(page, "Files").click();
  await expect(page.getByRole("heading", { name: /as a webcam/ })).toHaveCount(0);
  await expect.poll(async () => (await named(page, "webcamDetachPreview")).length).toBeGreaterThan(0);
  expect(await named(page, "webcamStop")).toHaveLength(0); // unlike Mirror, leaving does NOT stop it

  await goWebcam(page);
  await expect(stop(page)).toBeVisible();
  await expect(page.getByText("tcp://127.0.0.1:5400", { exact: true })).toBeVisible();
  // Attaches and detaches pair up (React's dev StrictMode attaches twice on mount, so don't count exactly):
  // while the screen is open exactly one preview is attached.
  const attached = async () => (await named(page, "webcamAttachPreview")).length - (await named(page, "webcamDetachPreview")).length;
  await expect.poll(attached).toBe(1);
  expect((await named(page, "webcamAttachPreview")).length).toBeGreaterThan(1);
  await nav(page, "Files").click();
  await expect.poll(attached).toBe(0);
  await goWebcam(page);
  await expect.poll(attached).toBe(1);
  expect(await named(page, "webcamStop")).toHaveLength(0);
  expect(await named(page, "webcamStart")).toHaveLength(1); // coming back didn't start a second session
});

test("a session that's already running is picked up again (e.g. after a reload)", async ({ page }) => {
  await open(page);
  await start(page).click();
  await expect(stop(page)).toBeVisible();
  await page.evaluate(async () => {
    const m = await import("/src/store/webcam.ts");
    m.useWebcam.setState({ info: null }); // the UI forgot…
    m.useWebcam.getState().init(); // …and asks the backend on startup
  });
  await expect(stop(page)).toBeVisible();
});

test("Stop ends the session and brings Start back", async ({ page }) => {
  await open(page);
  await start(page).click();
  await stop(page).click();
  await expect(start(page)).toBeVisible();
  expect(await named(page, "webcamStop")).toHaveLength(1);
  await expect(page.getByRole("meter")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "720p" })).toBeEnabled();
});

test("when the backend ends the session (phone unplugged, encoder died) the reason is shown, even from another screen", async ({ page }) => {
  await open(page);
  await start(page).click();
  await expect(stop(page)).toBeVisible();
  await nav(page, "Files").click();
  await emit(page, "ended", "The phone was disconnected.");
  await expect(page.getByText("Webcam stopped: The phone was disconnected.")).toBeVisible(); // toast, visible anywhere
  await goWebcam(page);
  await expect(page.getByRole("alert")).toContainText("The phone was disconnected.");
  await expect(start(page)).toBeVisible();
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);

  // a quiet end (no reason) just says so
  await start(page).click();
  await expect(stop(page)).toBeVisible();
  await emit(page, "ended", null);
  await expect(page.getByText("Webcam stopped", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(start(page)).toBeVisible();
});

test("a failed start shows the backend's message and leaves the webcam off", async ({ page }) => {
  await open(page, { startError: "The camera is in use by another app." });
  await start(page).click();
  await expect(page.getByRole("alert")).toContainText("The camera is in use by another app.");
  await expect(start(page)).toBeEnabled();
  await expect(stop(page)).toHaveCount(0);
});

test("Webcam is in the sidebar and can be reached from ⌘K", async ({ page }) => {
  await open(page);
  await expect(nav(page, "Webcam")).toHaveAttribute("aria-current", "page");
  await nav(page, "Files").click();
  await page.keyboard.press("Meta+k");
  await expect(page.getByRole("dialog").getByText("Use your phone as a camera and mic in Zoom, Meet and more.")).toBeVisible();
  await page.keyboard.type("webcam");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: /as a webcam/ })).toBeVisible();
});
