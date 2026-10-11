import { describe, expect, it } from "vitest";
import { codecFromSps, mapPoint, planKey } from "./mirror";

const ev = (o: Partial<Parameters<typeof planKey>[0]>) => ({ key: "", code: "", altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...o });

describe("codecFromSps", () => {
  it("builds the avc1 string from a 4-byte start code SPS", () => {
    expect(codecFromSps(new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a, 0xac]))).toBe("avc1.64002a");
  });
  it("handles 3-byte start codes and skips non-SPS units", () => {
    expect(codecFromSps(new Uint8Array([0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 1]))).toBe("avc1.42c01f");
    expect(codecFromSps(new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3, 4]))).toBeNull();
  });
});

describe("mapPoint", () => {
  const rect = { left: 100, top: 50, width: 360, height: 800 };
  it("scales a click to the phone's pixel grid", () => {
    expect(mapPoint(rect, 720, 1600, 280, 450)).toEqual({ x: 360, y: 800 });
  });
  it("clamps drags that leave the screen to the edges", () => {
    expect(mapPoint(rect, 720, 1600, -50, 9999)).toEqual({ x: 0, y: 1599 });
    expect(mapPoint(rect, 720, 1600, 9999, -50)).toEqual({ x: 719, y: 0 });
  });
});

describe("planKey", () => {
  it("types printable characters as text and maps editing keys", () => {
    expect(planKey(ev({ key: "a" }))).toEqual({ kind: "text", text: "a" });
    expect(planKey(ev({ key: "é" }))).toEqual({ kind: "text", text: "é" });
    expect(planKey(ev({ key: "Enter" }))).toEqual({ kind: "key", keycode: 66 });
    expect(planKey(ev({ key: "Backspace" }))).toEqual({ kind: "key", keycode: 67 });
    expect(planKey(ev({ key: "Escape" }))).toEqual({ kind: "key", keycode: 4 }); // Escape = Back
  });
  it("leaves ⌘/⌃ combos to macOS", () => {
    expect(planKey(ev({ key: "c", metaKey: true }))).toBeNull();
    expect(planKey(ev({ key: "v", ctrlKey: true }))).toBeNull();
  });
  it("uses ⌥ combos as phone shortcuts", () => {
    expect(planKey(ev({ code: "KeyH", altKey: true, key: "˙" }))).toEqual({ kind: "shortcut", name: "home" });
    expect(planKey(ev({ code: "KeyB", altKey: true }))).toEqual({ kind: "shortcut", name: "back" });
    expect(planKey(ev({ code: "KeyN", altKey: true, shiftKey: true }))).toEqual({ kind: "shortcut", name: "settings" });
    expect(planKey(ev({ code: "ArrowUp", altKey: true }))).toEqual({ kind: "shortcut", name: "volUp" });
    expect(planKey(ev({ code: "KeyZ", altKey: true }))).toBeNull();
  });
  it("ignores modifier-only and function keys", () => {
    expect(planKey(ev({ key: "Shift" }))).toBeNull();
    expect(planKey(ev({ key: "F5" }))).toBeNull();
  });
});
