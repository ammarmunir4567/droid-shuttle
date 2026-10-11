import { expect, test, type Page } from "@playwright/test";

type Call = { name: string; args: any };
const calls = (p: Page) => p.evaluate(() => (window as unknown as { __calls?: Call[] }).__calls ?? []);
const named = async (p: Page, n: string) => (await calls(p)).filter((c) => c.name === n).map((c) => c.args);
const tab = (p: Page, name: string) => p.getByRole("tab", { name });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Tools" }).click();
});

test("Device tab shows battery, memory, storage and device details", async ({ page }) => {
  const battery = page.getByLabel("Battery");
  await expect(battery).toContainText("82%");
  await expect(battery).toContainText("Charging");
  await expect(battery).toContainText("31.2 °C");
  await expect(page.getByLabel("Memory and storage")).toContainText("128.0 GB");
  const dev = page.getByLabel("Device details");
  await expect(dev).toContainText("Google Pixel 8 Pro");
  await expect(dev).toContainText("Android");
  await expect(dev).toContainText("1d 2h"); // 93,784 s of uptime
  await expect(dev).toContainText("Wi-Fi address 192.168.1.37");
});

test("Terminal opens a shell, shows output and sends what you type", async ({ page }) => {
  await tab(page, "Terminal").click();
  await expect(page.getByLabel("Terminal", { exact: true })).toContainText("mock:/ $");
  expect((await named(page, "shellStart"))[0]).toMatchObject({ cols: expect.any(Number), rows: expect.any(Number) });
  await page.keyboard.type("ls\r");
  await expect.poll(async () => (await named(page, "shellWrite")).map((w) => w.text).join("")).toBe("ls\r");
  // leaving the tab closes the shell
  await tab(page, "Device").click();
  await expect.poll(async () => (await named(page, "shellClose")).length).toBeGreaterThan(0);
});

test.describe("Log viewer", () => {
  const rows = (p: Page) => p.getByRole("log", { name: "Log output" }).getByRole("row");
  test.beforeEach(async ({ page }) => { await tab(page, "Log").click(); await expect(rows(page).first()).toBeVisible(); });

  test("shows parsed lines with tag, level and message; ignores buffer headers", async ({ page }) => {
    await expect(rows(page)).toHaveCount(6);
    await expect(rows(page).nth(1)).toContainText("ExampleApp");
    await expect(rows(page).nth(1)).toContainText("onCreate called");
    await expect(page.getByText("6 lines")).toBeVisible();
  });

  test("filters by level, tag, text and /regex/", async ({ page }) => {
    await page.getByLabel("Minimum level").selectOption("W");
    await expect(rows(page)).toHaveCount(3); // W, E, F
    await page.getByLabel("Minimum level").selectOption("V");
    await page.getByLabel("Filter by tag").fill("exampleapp");
    await expect(rows(page)).toHaveCount(3);
    await page.getByLabel("Filter by tag").fill("");
    await page.getByLabel("Search log").fill("FAILED");
    await expect(rows(page)).toHaveCount(1);
    await page.getByLabel("Search log").fill("/slow|fatal/");
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByText("2 lines of 6")).toBeVisible();
  });

  test("filtering by app package asks the phone for its process ids", async ({ page }) => {
    await page.getByLabel("Filter by app package").fill("com.example.app");
    await expect.poll(async () => (await named(page, "pidsOfPackage")).length).toBeGreaterThan(0);
    await expect(rows(page)).toHaveCount(3); // pid 4242 only
    await expect(page.getByText("showing PID 4242")).toBeVisible();
  });

  test("pause holds new lines until you resume; clear empties the view and the phone's buffer", async ({ page }) => {
    await page.getByRole("button", { name: "Pause" }).click();
    await page.evaluate(() => (window as any).__logPush("10-04 17:17:00.000  4242  4242 I Late: arrived while paused\n"));
    await expect(page.getByText(/Paused — 1 new line waiting/)).toBeVisible();
    await expect(rows(page)).toHaveCount(6);
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(rows(page)).toHaveCount(7);
    await page.getByRole("button", { name: "Clear log" }).click();
    await expect(page.getByText("0 lines")).toBeVisible();
    expect((await named(page, "logcatClear")).length).toBe(1);
  });

  test("lines split across stream chunks are stitched back together", async ({ page }) => {
    await page.evaluate(() => { const p = (window as any).__logPush; p("10-04 17:17:01.000  1  1 I Split: first "); p("half and second half\n"); });
    await expect(rows(page).last()).toContainText("first half and second half");
  });

  test("leaving the tab stops the stream", async ({ page }) => {
    await tab(page, "Device").click();
    await expect.poll(async () => (await named(page, "logcatStop")).length).toBeGreaterThan(0);
  });
});

test.describe("Wireless", () => {
  test.beforeEach(async ({ page }) => { await tab(page, "Wireless").click(); });

  test("Go wireless needs a cable and a Wi-Fi address, then connects", async ({ page }) => {
    await expect(page.getByText("Phone's Wi-Fi address: 192.168.1.37")).toBeVisible();
    await page.getByRole("button", { name: "Go wireless" }).click();
    expect((await named(page, "wifiGoWireless"))[0]).toEqual({ serial: "MOCK123" });
    await expect(page.getByText(/Connected to 192\.168\.1\.37:5555/)).toBeVisible();
  });

  test("pairing code form validates address and 6-digit code before enabling Pair", async ({ page }) => {
    const pair = page.getByRole("button", { name: "Pair", exact: true });
    await expect(pair).toBeDisabled();
    await page.getByLabel("Pairing address", { exact: true }).fill("not an address");
    await page.getByLabel("Pairing code", { exact: true }).fill("123456");
    await expect(pair).toBeDisabled();
    await page.getByLabel("Pairing address", { exact: true }).fill("192.168.1.37:41201");
    await page.getByLabel("Pairing code", { exact: true }).fill("12a3b45"); // non-digits are dropped
    await expect(page.getByLabel("Pairing code", { exact: true })).toHaveValue("12345");
    await expect(pair).toBeDisabled();
    await page.getByLabel("Pairing code", { exact: true }).fill("123456");
    await pair.click();
    expect((await named(page, "wifiPair"))[0]).toEqual({ hostPort: "192.168.1.37:41201", code: "123456" });
  });

  test("manual connect validates host:port", async ({ page }) => {
    const btn = page.getByRole("button", { name: "Connect", exact: true }).first();
    await expect(btn).toBeDisabled();
    await page.getByLabel("Connect address", { exact: true }).fill("192.168.1.37:37099");
    await btn.click();
    expect((await named(page, "wifiConnect"))[0]).toEqual({ hostPort: "192.168.1.37:37099" });
  });

  test("QR pairing shows a code and waits for the phone", async ({ page }) => {
    await page.getByRole("button", { name: "Show QR code" }).click();
    await expect(page.getByLabel("Pairing QR code")).toBeVisible();
    await expect.poll(async () => (await named(page, "wifiQrFinish")).length).toBeGreaterThan(0);
    expect((await named(page, "wifiQrFinish"))[0]).toMatchObject({ name: "studio-abc", password: "123456789012" });
  });

  test("lists phones found on the network and can connect or prefill pairing", async ({ page }) => {
    await expect(page.getByText(/adb-MOCK-abc/)).toBeVisible();
    await page.getByRole("button", { name: "Connect" }).last().click();
    expect((await named(page, "wifiConnect")).pop()).toEqual({ hostPort: "192.168.1.37:37099" });
    await page.getByRole("button", { name: "Use for pairing" }).click();
    await expect(page.getByLabel("Pairing address", { exact: true })).toHaveValue("192.168.1.37:41201");
  });
});
