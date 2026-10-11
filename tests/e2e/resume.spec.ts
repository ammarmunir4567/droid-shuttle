import { expect, test, type Page } from "@playwright/test";

const emit = (p: Page, s: object) => p.evaluate((x) => (window as any).__emitTransfer(x), s);
const snap = (o: object) => ({ id: 31, label: "Holiday.mp4", direction: "pull", status: "running", bytesTotal: 800e6, bytesDone: 300e6, filesTotal: 1, filesDone: 0, filesSkipped: 0, current: "Holiday.mp4", speedBps: 40e6, errors: [], verified: 0, startedMs: 0, finishedMs: null, reconnects: 0, ...o });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("[role=row]");
});

test("pulling the cable pauses transfers with a clear message, and they carry on when the phone returns", async ({ page }) => {
  const tray = page.getByRole("region", { name: "Transfers" });
  await emit(page, snap({}));
  await expect(tray).toContainText("1 transfer in progress");

  // Cable pulled: the backend reports "waiting"; no failure, no error toast.
  await emit(page, snap({ status: "waiting", speedBps: 0 }));
  await expect(tray).toContainText("Waiting for your phone");
  await expect(tray).toContainText("Plug it back in and this continues where it stopped");
  await expect(page.getByText("Your phone disconnected. Transfers are paused and will continue when you plug it back in.")).toBeVisible();
  await expect(tray.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0); // nothing to pause while unplugged
  await expect(tray.getByRole("button", { name: "Cancel", exact: true })).toBeVisible(); // but you can still give up

  // A second job also waiting must not stack another toast.
  await emit(page, snap({ id: 32, label: "Photos", status: "waiting", speedBps: 0 }));
  await expect(page.getByText(/Your phone disconnected/)).toHaveCount(1);
  await expect(tray).toContainText("2 transfers paused");

  // Phone is back: both continue, one toast, progress picks up from where it stopped.
  await emit(page, snap({ id: 32, label: "Photos", reconnects: 1 }));
  await emit(page, snap({ bytesDone: 300e6, reconnects: 1 }));
  await expect(page.getByText("Phone is back. Transfers are continuing.")).toHaveCount(1);
  await expect(tray).toContainText("2 transfers in progress");
  await expect(tray).toContainText("300.0 MB of 800.0 MB");
});

test("canceling while waiting just says canceled, with no “phone is back” toast", async ({ page }) => {
  await emit(page, snap({ status: "waiting", speedBps: 0 }));
  await emit(page, snap({ status: "canceled", finishedMs: 5, speedBps: 0 }));
  await expect(page.getByText("Canceled “Holiday.mp4”")).toBeVisible();
  await expect(page.getByText("Phone is back")).toHaveCount(0);
});
