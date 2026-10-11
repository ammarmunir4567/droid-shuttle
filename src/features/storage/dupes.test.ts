import { describe, expect, it } from "vitest";
import type { DupGroup, StorageFile } from "../../lib/api";
import { defaultChoices, deletions, pickKeeper, reclaimable } from "./dupes";

const f = (path: string, mtime: number, size = 100): StorageFile => ({ path, name: path.split("/").pop()!, size, mtime, category: "images" });
const group = (hash: string, files: StorageFile[]): DupGroup => ({ size: files[0].size, hash, files });
const a = group("A", [f("/sdcard/DCIM/Camera/IMG_1.jpg", 10), f("/sdcard/Download/IMG_1 (1).jpg", 30), f("/sdcard/x.jpg", 20)]);
const b = group("B", [f("/sdcard/Documents/report.pdf", 5, 2000), f("/sdcard/Download/report.pdf", 6, 2000)]);

describe("choosing which copy to keep", () => {
  it("applies the chosen rule, with a stable tie-break", () => {
    expect(pickKeeper(a, "oldest")).toBe("/sdcard/DCIM/Camera/IMG_1.jpg");
    expect(pickKeeper(a, "newest")).toBe("/sdcard/Download/IMG_1 (1).jpg");
    expect(pickKeeper(a, "shortest")).toBe("/sdcard/x.jpg");
    const tie = group("T", [f("/b", 1), f("/a", 1)]);
    expect(pickKeeper(tie, "oldest")).toBe("/a");
  });

  it("deletes every copy except the kept one, and counts the bytes freed", () => {
    const choices = defaultChoices([a, b], "oldest");
    const gone = deletions([a, b], choices);
    expect(gone.map((x) => x.path)).toEqual(["/sdcard/Download/IMG_1 (1).jpg", "/sdcard/x.jpg", "/sdcard/Download/report.pdf"]);
    expect(reclaimable(gone)).toBe(100 + 100 + 2000);
  });

  it("never deletes the last copy: one file per set always survives", () => {
    for (const rule of ["oldest", "newest", "shortest"] as const) {
      const gone = deletions([a, b], defaultChoices([a, b], rule));
      expect(gone.length).toBe(a.files.length - 1 + b.files.length - 1);
      for (const g of [a, b]) expect(g.files.some((x) => !gone.includes(x))).toBe(true);
    }
    // A stale choice that points at a file no longer in the set falls back to a real one instead of deleting everything.
    const stale = { A: { keep: "/sdcard/gone.jpg", skip: false } };
    expect(deletions([a], stale).length).toBe(2);
    // A missing choice deletes nothing.
    expect(deletions([a], {})).toEqual([]);
  });

  it("leaves skipped sets alone and remembers skips when the rule changes", () => {
    const choices = defaultChoices([a, b], "oldest");
    choices.A.skip = true;
    expect(deletions([a, b], choices).map((x) => x.path)).toEqual(["/sdcard/Download/report.pdf"]);
    const again = defaultChoices([a, b], "newest", choices);
    expect(again.A).toEqual({ keep: "/sdcard/Download/IMG_1 (1).jpg", skip: true });
    expect(again.B.skip).toBe(false);
  });
});
