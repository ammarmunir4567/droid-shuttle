import { describe, expect, it } from "vitest";
import type { AudioDevice, PhoneCamera, WebcamPrereqs } from "../../lib/api";
import {
  DEFAULT_OPTIONS, androidVersion, autoDeviceLabel, cameraLabel, compatibilityNotes, meterFill, normalizeOptions, obsSteps, obsUrl,
  outputWarning, presetOf, selectedCamera, sizeListed, sortedDevices, withCamera, withFacing,
} from "./helpers";

const back: PhoneCamera = { id: "0", facing: "back", width: 4000, height: 3000, fps: [15, 30], sizes: [{ width: 1920, height: 1080 }, { width: 640, height: 480 }] };
const front: PhoneCamera = { id: "1", facing: "front", width: 1920, height: 1080, fps: [30], sizes: [] };
const wide: PhoneCamera = { id: "2", facing: "back", width: 3000, height: 2000, fps: [30], sizes: [] };
const bh: AudioDevice = { name: "BlackHole 2ch", isBlackhole: true, supports48k: true };
const speakers: AudioDevice = { name: "MacBook Pro Speakers", isBlackhole: false, supports48k: true };

describe("normalizeOptions", () => {
  it("returns the defaults for anything that isn't an object", () => {
    for (const bad of [null, undefined, 3, "x", []]) expect(normalizeOptions(bad)).toEqual(DEFAULT_OPTIONS);
  });
  it("keeps valid values", () => {
    const o = { ...DEFAULT_OPTIONS, cameraId: "1", facing: "front" as const, width: 1280, height: 720, fps: 24, rotation: 90, mic: false, micSource: "mic-camcorder" as const, audioDelayMs: 250, outputDevice: "BlackHole 2ch", port: 5401, bitRateMbps: 8 };
    expect(normalizeOptions(o)).toEqual(o);
  });
  it("repairs out-of-range and mistyped fields one by one", () => {
    const o = normalizeOptions({ facing: "sideways", width: "wide", height: -5, fps: 60, rotation: 45, mic: "yes", micSource: "bogus", audioDelayMs: 99999, outputDevice: 7, port: 70000, bitRateMbps: -3, cameraId: "../x" });
    expect(o).toEqual({ ...DEFAULT_OPTIONS, height: 120, audioDelayMs: 1000, port: 65535 });
  });
  it("treats the server's automatic frame rate (0) as 30 fps, and rounds numbers", () => {
    expect(normalizeOptions({ fps: 0 }).fps).toBe(30);
    expect(normalizeOptions({ audioDelayMs: 120.6 }).audioDelayMs).toBe(121);
  });
  it("drops unknown keys (an older build's options can't leak into the backend call)", () => {
    expect(Object.keys(normalizeOptions({ maxSize: 1280, mic: true })).sort()).toEqual(Object.keys(DEFAULT_OPTIONS).sort());
  });
});

describe("resolution", () => {
  it("recognises the presets and leaves custom sizes alone", () => {
    expect(presetOf(1280, 720)?.id).toBe("720p");
    expect(presetOf(1920, 1080)?.id).toBe("1080p");
    expect(presetOf(1600, 900)).toBeNull();
  });
  it("says whether a camera lists a size; unknown sizes never block", () => {
    expect(sizeListed(back, 1920, 1080)).toBe(true);
    expect(sizeListed(back, 1280, 720)).toBe(false);
    expect(sizeListed(front, 1280, 720)).toBe(true); // no declared sizes → can't tell
    expect(sizeListed(undefined, 1280, 720)).toBe(true);
  });
});

describe("cameras", () => {
  it("labels by facing with the largest size", () => {
    expect(cameraLabel(back)).toBe("Back camera (4000×3000)");
    expect(cameraLabel(front)).toBe("Front camera (1920×1080)");
    expect(cameraLabel({ ...front, facing: "weird" })).toBe("Camera 1 (1920×1080)");
    expect(cameraLabel({ ...front, width: 0, height: 0 })).toBe("Front camera");
  });
  it("adds the id when two cameras face the same way", () => {
    const all = [back, front, wide];
    expect(cameraLabel(back, all)).toBe("Back camera · 0 (4000×3000)");
    expect(cameraLabel(wide, all)).toBe("Back camera · 2 (3000×2000)");
    expect(cameraLabel(front, all)).toBe("Front camera (1920×1080)");
  });
  it("selects by id (keeping facing in step) or by facing alone", () => {
    expect(withCamera(DEFAULT_OPTIONS, front)).toMatchObject({ cameraId: "1", facing: "front" });
    expect(withFacing({ ...DEFAULT_OPTIONS, cameraId: "1" }, "front")).toMatchObject({ cameraId: "", facing: "front" });
  });
  it("finds the camera the options point at", () => {
    const all = [back, front, wide];
    expect(selectedCamera({ ...DEFAULT_OPTIONS, cameraId: "2" }, all)).toBe(wide);
    expect(selectedCamera({ ...DEFAULT_OPTIONS, cameraId: "", facing: "front" }, all)).toBe(front);
    expect(selectedCamera({ ...DEFAULT_OPTIONS, cameraId: "9" }, all)).toBeUndefined();
  });
});

describe("compatibility", () => {
  const p = (o: Partial<WebcamPrereqs>): WebcamPrereqs => ({ obsInstalled: true, blackholeInstalled: true, sdk: 35, cameraSupported: true, micSupported: true, ...o });
  it("names Android versions", () => {
    expect([29, 30, 31, 33, 35, 36, 37, 20].map(androidVersion)).toEqual(["10", "11", "12", "13", "15", "16", "17", "API 20"]);
  });
  it("only complains about what the phone can't do", () => {
    expect(compatibilityNotes(null)).toEqual({ camera: null, mic: null });
    expect(compatibilityNotes(p({}))).toEqual({ camera: null, mic: null });
    expect(compatibilityNotes(p({ sdk: 30, cameraSupported: false }))).toEqual({ camera: "Camera needs Android 12 or newer. This phone runs Android 11.", mic: null });
    expect(compatibilityNotes(p({ sdk: 29, cameraSupported: false, micSupported: false }))).toMatchObject({ mic: expect.stringContaining("Android 11 or newer") });
  });
});

describe("OBS recipe", () => {
  it("builds the URL from the port, defaulting to 5400", () => {
    expect(obsUrl(0)).toBe("tcp://127.0.0.1:5400");
    expect(obsUrl(5411)).toBe("tcp://127.0.0.1:5411");
  });
  it("has four steps and puts the URL in the first", () => {
    const s = obsSteps("tcp://127.0.0.1:5400");
    expect(s).toHaveLength(4);
    expect(s[0]).toContain("tcp://127.0.0.1:5400");
    expect(s[0]).toMatch(/Media Source/);
    expect(s[1]).toMatch(/Start Virtual Camera/);
    expect(s[2]).toContain("OBS Virtual Camera");
    expect(s[3]).toContain("BlackHole 2ch");
  });
});

describe("audio output", () => {
  it("labels Automatic by whether BlackHole is there, and lists BlackHole first", () => {
    expect(autoDeviceLabel([speakers, bh])).toBe("Automatic (BlackHole 2ch)");
    expect(autoDeviceLabel([speakers])).toMatch(/isn't installed/);
    expect(sortedDevices([speakers, bh]).map((d) => d.name)).toEqual(["BlackHole 2ch", "MacBook Pro Speakers"]);
  });
  it("warns only when the mic wouldn't reach the call apps", () => {
    expect(outputWarning([bh, speakers], "", true)).toBeNull();
    expect(outputWarning([speakers], "", true)).toMatch(/BlackHole isn't installed/);
    expect(outputWarning([speakers], "", false)).toBeNull(); // mic off → nothing to route
    expect(outputWarning([bh], "Ghost", true)).toMatch(/isn't available/);
    expect(outputWarning([{ ...bh, supports48k: false }], "BlackHole 2ch", true)).toMatch(/48 kHz/);
    expect(outputWarning([bh, speakers], "MacBook Pro Speakers", true)).toMatch(/through BlackHole/);
    expect(outputWarning([bh], "BlackHole 2ch", true)).toBeNull();
  });
});

describe("meterFill", () => {
  it("is empty for silence and bad input, full at full scale", () => {
    expect(meterFill(0)).toBe(0);
    expect(meterFill(-1)).toBe(0);
    expect(meterFill(NaN)).toBe(0);
    expect(meterFill(1)).toBe(1);
    expect(meterFill(5)).toBe(1);
  });
  it("uses a decibel scale: −60 dB is empty, −30 dB is half, ordinary speech is visible", () => {
    expect(meterFill(0.001)).toBeCloseTo(0, 5);
    expect(meterFill(10 ** (-30 / 20))).toBeCloseTo(0.5, 5);
    expect(meterFill(0.1)).toBeGreaterThan(0.6);
    expect(meterFill(0.2)).toBeGreaterThan(meterFill(0.1));
  });
});
