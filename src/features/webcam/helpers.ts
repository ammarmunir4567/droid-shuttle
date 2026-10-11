// Pure helpers for the Webcam screen: option validation, labels, the OBS recipe and meter maths.
// Kept free of React and the backend so they can be unit-tested in plain node.
import type { AudioDevice, CameraFacing, CameraOptions, MicSource, PhoneCamera, WebcamPrereqs } from "../../lib/api";

export const DEFAULT_PORT = 5400;
export const STORAGE_KEY = "db.webcam.opts";

export const DEFAULT_OPTIONS: CameraOptions = {
  cameraId: "",
  facing: "back", // the rear camera is the better sensor
  width: 1920,
  height: 1080,
  fps: 30,
  bitRateMbps: 0,
  rotation: 0,
  mic: true,
  micSource: "mic",
  audioDelayMs: 0,
  outputDevice: "",
  port: 0,
};

export const RESOLUTION_PRESETS = [
  { id: "720p", label: "720p", width: 1280, height: 720 },
  { id: "1080p", label: "1080p", width: 1920, height: 1080 },
] as const;
export type Preset = (typeof RESOLUTION_PRESETS)[number];

export const FPS_CHOICES = [24, 30] as const;
export const ROTATIONS = [0, 90, 180, 270] as const;
export const BIT_RATES: [number, string][] = [[0, "Automatic"], [4, "4 Mbit/s"], [8, "8 Mbit/s"], [16, "16 Mbit/s"]];

export const MIC_SOURCES: { id: MicSource; label: string }[] = [
  { id: "mic", label: "Standard microphone" },
  { id: "mic-voice-communication", label: "Voice call (echo and noise reduction)" },
  { id: "mic-camcorder", label: "Camcorder (tuned for video)" },
  { id: "mic-voice-recognition", label: "Voice recognition" },
  { id: "mic-unprocessed", label: "Unprocessed (raw)" },
];

const FACINGS: CameraFacing[] = ["front", "back", "external"];
const MIC_IDS = MIC_SOURCES.map((m) => m.id);

const num = (v: unknown, fallback: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback);

/**
 * Anything read from storage (an older build, a hand-edited value, garbage) → a valid options object.
 * Unknown keys are dropped; every field falls back to its default when missing or out of range.
 */
export function normalizeOptions(raw: unknown): CameraOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_OPTIONS;
  const width = num(o.width, d.width, 160, 7680);
  const height = num(o.height, d.height, 120, 4320);
  return {
    cameraId: typeof o.cameraId === "string" && /^[A-Za-z0-9_.:-]{0,32}$/.test(o.cameraId) ? o.cameraId : d.cameraId,
    facing: FACINGS.includes(o.facing as CameraFacing) ? (o.facing as CameraFacing) : d.facing,
    width,
    height,
    fps: o.fps === 24 ? 24 : 30, // the server default (0) is 30 fps, so "automatic" and 30 are the same thing
    bitRateMbps: num(o.bitRateMbps, d.bitRateMbps, 0, 100),
    rotation: ROTATIONS.includes(o.rotation as (typeof ROTATIONS)[number]) ? (o.rotation as number) : d.rotation,
    mic: typeof o.mic === "boolean" ? o.mic : d.mic,
    micSource: MIC_IDS.includes(o.micSource as MicSource) ? (o.micSource as MicSource) : d.micSource,
    audioDelayMs: num(o.audioDelayMs, d.audioDelayMs, 0, 1000),
    outputDevice: typeof o.outputDevice === "string" ? o.outputDevice.slice(0, 200) : d.outputDevice,
    port: num(o.port, d.port, 0, 65535),
  };
}

/** The preset that matches a size exactly, or null for a custom size. */
export function presetOf(width: number, height: number): Preset | null {
  return RESOLUTION_PRESETS.find((p) => p.width === width && p.height === height) ?? null;
}

/** Whether the camera declares this size. Declared sizes aren't fully reliable (scrcpy says so), so this only drives a hint. */
export function sizeListed(cam: PhoneCamera | undefined, width: number, height: number): boolean {
  return !cam || cam.sizes.length === 0 || cam.sizes.some((s) => s.width === width && s.height === height);
}

const FACING_NAME: Record<string, string> = { front: "Front camera", back: "Back camera", external: "External camera" };

/** “Back camera (4000×3000)”; cameras that share a facing also get their id so they can be told apart. */
export function cameraLabel(cam: PhoneCamera, all: PhoneCamera[] = [cam]): string {
  const base = FACING_NAME[cam.facing] ?? `Camera ${cam.id}`;
  const twin = FACING_NAME[cam.facing] !== undefined && all.filter((c) => c.facing === cam.facing).length > 1;
  const size = cam.width && cam.height ? ` (${cam.width}×${cam.height})` : "";
  return `${base}${twin ? ` · ${cam.id}` : ""}${size}`;
}

export const asFacing = (f: string): CameraFacing => (FACINGS.includes(f as CameraFacing) ? (f as CameraFacing) : "back");

/** Pick a listed camera: by id, with its facing kept in step. */
export function withCamera(o: CameraOptions, cam: PhoneCamera): CameraOptions {
  return { ...o, cameraId: cam.id, facing: asFacing(cam.facing) };
}
/** Pick by facing only (no camera list, or the user's choice of “Front/Back”). */
export function withFacing(o: CameraOptions, facing: CameraFacing): CameraOptions {
  return { ...o, cameraId: "", facing };
}
/** Which listed camera the options point at (by id, else the first one facing the right way). */
export function selectedCamera(o: CameraOptions, cams: PhoneCamera[]): PhoneCamera | undefined {
  return cams.find((c) => c.id === o.cameraId) ?? (o.cameraId ? undefined : cams.find((c) => c.facing === o.facing));
}

/** 30 → Android 11, 31 → 12 … so a message can say what the phone runs. */
export function androidVersion(sdk: number): string {
  const table: Record<number, string> = { 29: "10", 30: "11", 31: "12", 32: "12L", 33: "13", 34: "14", 35: "15", 36: "16" };
  return table[sdk] ?? (sdk > 36 ? `${sdk - 20}` : `API ${sdk}`);
}

export function compatibilityNotes(p: WebcamPrereqs | null): { camera: string | null; mic: string | null } {
  if (!p) return { camera: null, mic: null };
  const on = `This phone runs Android ${androidVersion(p.sdk)}.`;
  return {
    camera: p.cameraSupported ? null : `Camera needs Android 12 or newer. ${on}`,
    mic: p.micSupported ? null : `Microphone capture needs Android 11 or newer. ${on}`,
  };
}

export const obsUrl = (port: number) => `tcp://127.0.0.1:${port || DEFAULT_PORT}`;

export const INSTALL = {
  obs: { name: "OBS Studio", cmd: "brew install --cask obs", url: "https://obsproject.com" },
  blackhole: { name: "BlackHole 2ch", cmd: "brew install --cask blackhole-2ch", url: "https://existential.audio/blackhole" },
} as const;

/** The one-time OBS + Zoom/Meet recipe. */
export function obsSteps(url: string): string[] {
  return [
    `In OBS, under Sources click +, choose Media Source, untick “Local File”, paste ${url}, tick “Use hardware decoding” and set Network Buffering to 0 MB.`,
    "Click Start Virtual Camera in OBS.",
    "In Zoom, Meet or any recorder, choose the camera “OBS Virtual Camera”.",
    "Choose the microphone “BlackHole 2ch”.",
  ];
}

/** Auto output = BlackHole when it's there. */
export function autoDeviceLabel(devices: AudioDevice[]): string {
  const bh = devices.find((d) => d.isBlackhole);
  return bh ? `Automatic (${bh.name})` : "Automatic (BlackHole isn't installed)";
}

/** Devices to offer, BlackHole first. */
export function sortedDevices(devices: AudioDevice[]): AudioDevice[] {
  return [...devices].sort((a, b) => Number(b.isBlackhole) - Number(a.isBlackhole) || a.name.localeCompare(b.name));
}

/** Something worth telling the user about where the mic will go, or null when it's fine. */
export function outputWarning(devices: AudioDevice[], outputDevice: string, mic: boolean): string | null {
  if (!mic) return null;
  if (outputDevice === "") {
    return devices.some((d) => d.isBlackhole) ? null : "BlackHole isn't installed, so the phone's microphone can't reach Zoom or Meet. Install it, then Re-check.";
  }
  const d = devices.find((x) => x.name === outputDevice);
  if (!d) return `“${outputDevice}” isn't available right now. Pick another output or use Automatic.`;
  if (!d.supports48k) return `“${d.name}” doesn't support 48 kHz, so the sound may be resampled or fail.`;
  if (!d.isBlackhole) return `“${d.name}” plays through that device's speakers; Zoom and Meet can only pick it up as a microphone through BlackHole.`;
  return null;
}

/** RMS level (0..1) → how full the meter is (0..1), on a decibel scale so quiet speech still moves it. */
export function meterFill(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0;
  const db = 20 * Math.log10(Math.min(1, level));
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

export const formatDelay = (ms: number) => `${ms} ms`;

/** A phone's start result in plain words, for the live status line. */
export function liveSummary(o: CameraOptions, micActive: boolean): string {
  const preset = presetOf(o.width, o.height)?.label ?? `${o.width}×${o.height}`;
  return `${preset} · ${o.fps} fps · ${micActive ? "mic on" : "mic off"}`;
}
