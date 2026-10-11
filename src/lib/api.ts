// Typed bridge to the Rust core. Falls back to a mock when running in a plain
// browser (Vite dev / Playwright), so the UI is developable without a phone.
import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type AdbState = "ready" | "unauthorized" | "offline" | "recovery" | "sideload" | "other";

export interface AdbDevice {
  serial: string;
  state: AdbState;
  model: string | null;
  product: string | null;
  transportId: string | null;
  wireless: boolean;
}

export interface DeviceInfo {
  serial: string;
  manufacturer: string;
  model: string;
  androidVersion: string;
  sdk: number;
  batteryLevel: number | null;
  batteryCharging: boolean;
  storageTotal: number;
  storageUsed: number;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  mtime: number;
}

export type Side = "device" | "local";
export type Direction = "push" | "pull" | "deviceCopy" | "deviceMove" | "localCopy" | "localMove";
export type Conflict = "replace" | "skip" | "keepBoth" | "update";

export interface TransferRequest {
  serial: string;
  direction: Direction;
  sources: string[];
  destDir: string;
  conflict: Conflict;
  verify?: boolean;
  deleteSource?: boolean;
}

export type TransferStatus = "scanning" | "running" | "paused" | "waiting" | "done" | "canceled";

export interface TransferSnapshot {
  id: number;
  label: string;
  direction: Direction;
  status: TransferStatus;
  bytesTotal: number;
  bytesDone: number;
  filesTotal: number;
  filesDone: number;
  filesSkipped: number;
  current: string | null;
  speedBps: number;
  errors: string[];
  verified: number;
  startedMs: number;
  finishedMs: number | null;
  /** Internal job (e.g. staging files for the clipboard): no "Finished" toast; clears itself. */
  silent?: boolean;
  /** How many times the phone dropped and this job carried on by itself. */
  reconnects?: number;
}


// ---------- storage analyzer ----------
export type StorageCategory = "images" | "videos" | "audio" | "documents" | "archives" | "apps" | "other";
export interface CategoryTotal { id: StorageCategory; bytes: number; files: number }
export interface StorageSummary { root: string; totalBytes: number; totalFiles: number; categories: CategoryTotal[]; finishedMs: number; tookMs: number }
export interface TreeNode { name: string; path: string; size: number; files: number; isDir: boolean; category: StorageCategory | null; mtime: number }
export interface StorageFile { path: string; name: string; size: number; mtime: number; category: StorageCategory }
export interface DupGroup { size: number; hash: string; files: StorageFile[] }
export interface StorageProgress { phase: "scan" | "fingerprint" | "hash"; files: number; bytes: number; total: number }

export interface MediaItem {
  id: number;
  path: string;
  kind: "image" | "video";
  mime: string;
  size: number;
  dateMs: number;
  width: number;
  height: number;
  durationMs: number;
  bucket: string;
  imported: boolean;
}
export interface MediaInfo {
  camera: string | null; lens: string | null; taken: string | null; exposure: string | null; aperture: string | null;
  iso: string | null; focalLength: string | null; software: string | null; latitude: number | null; longitude: number | null;
}
export type Organize = "flat" | "album" | "month";

export interface AppInfo {
  package: string; label: string; icon: string | null; versionName: string; versionCode: number; targetSdk: number;
  system: boolean; disabled: boolean; firstInstall: string; lastUpdate: string; installer: string; apkPath: string;
  appSize: number; dataSize: number; cacheSize: number;
}
export interface AppDetails { apkPaths: string[]; granted: string[]; denied: string[] }
export interface InstallOutcome { file: string; ok: boolean; message: string }

export interface BackupFolder { path: string; label: string; recommended: boolean }
export interface BackupRequest {
  serial: string; deviceName: string; destRoot: string; folders: string[]; includeApps: boolean; verify: boolean; encrypt: boolean; password?: string;
}
export interface BackupSummary {
  dest: string; filesCopied: number; filesSkipped: number; bytes: number; apps: number; errors: string[]; canceled: boolean; startedMs: number; finishedMs: number; encrypted: boolean;
}
export interface BackupRecord {
  id: number; device: string; dest: string; startedMs: number; finishedMs: number; filesCopied: number; filesSkipped: number; bytes: number; apps: number; errors: number; folders: string[];
}
export interface BackupContents {
  folders: { rel: string; bytes: number; files: number }[];
  apps: { package: string; label: string; versionName: string; dir: string; bytes: number }[];
}
export interface OpenedBackup { root: string; mounted: boolean; contents: BackupContents }
export interface EncryptedStatus { exists: boolean; hasPassword: boolean; path: string }

export interface MirrorOptions { maxSize: number; bitRateMbps: number; maxFps: number; screenOff: boolean; showTouches: boolean; stayAwake: boolean }
export type MirrorInput =
  | { type: "touch"; action: number; x: number; y: number; w: number; h: number; pressure: number }
  | { type: "key"; action: number; keycode: number; meta: number }
  | { type: "text"; text: string }
  | { type: "scroll"; x: number; y: number; w: number; h: number; hscroll: number; vscroll: number }
  | { type: "backOrScreenOn"; action: number }
  | { type: "panel"; kind: "notifications" | "settings" | "collapse" }
  | { type: "rotate" }
  | { type: "setClipboard"; text: string; paste: boolean }
  | { type: "displayPower"; on: boolean }
  | { type: "resetVideo" };

export interface DeviceStatus {
  batteryLevel: number | null; batteryStatus: string; batteryHealth: string; batteryTempC: number | null; batteryVoltageMv: number | null; plugged: string;
  memTotal: number; memAvailable: number; storageTotal: number; storageUsed: number; uptimeSecs: number; model: string; manufacturer: string;
  android: string; sdk: number; securityPatch: string; build: string; abi: string; screen: string; density: string; wifiIp: string | null; kernel: string;
}
export interface MdnsService { name: string; kind: string; address: string }
export interface QrInfo { name: string; password: string; payload: string }

// ---- Webcam: the phone's camera + mic as a Mac webcam/mic (via OBS Virtual Camera + BlackHole) ----
export type CameraFacing = "front" | "back" | "external";
export type MicSource = "mic" | "mic-voice-communication" | "mic-camcorder" | "mic-unprocessed" | "mic-voice-recognition";
export interface CameraOptions {
  /** "" = choose by `facing`. */
  cameraId: string;
  facing: CameraFacing;
  width: number;
  height: number;
  /** 0 = the server's default (30). */
  fps: number;
  /** 0 = the server's default. */
  bitRateMbps: number;
  /** 0 | 90 | 180 | 270; 0 = leave the picture as the phone delivers it. */
  rotation: number;
  mic: boolean;
  micSource: MicSource;
  /** 0..1000: delays the mic so it lines up with OBS's video latency. */
  audioDelayMs: number;
  /** "" = auto (BlackHole if installed). */
  outputDevice: string;
  /** 0 = the default (5400); the backend falls back to a free port. */
  port: number;
}
/** Camera needs Android 12 (sdk >= 31), the mic Android 11 (sdk >= 30). */
export interface WebcamPrereqs { obsInstalled: boolean; blackholeInstalled: boolean; sdk: number; cameraSupported: boolean; micSupported: boolean }
export interface PhoneCamera { id: string; facing: string; width: number; height: number; fps: number[]; sizes: { width: number; height: number }[] }
export interface AudioDevice { name: string; isBlackhole: boolean; supports48k: boolean }
export interface WebcamInfo { deviceName: string; obsUrl: string; port: number; micActive: boolean; micNote: string | null; outputDevice: string | null }

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const mockDevice: AdbDevice = { serial: "MOCK123", state: "ready", model: "Pixel 8 Pro", product: "husky", transportId: "1", wireless: false };
const mockInfo: DeviceInfo = {
  serial: "MOCK123", manufacturer: "Google", model: "Pixel 8 Pro", androidVersion: "15", sdk: 35,
  batteryLevel: 82, batteryCharging: true, storageTotal: 128e9, storageUsed: 71e9,
};

const mkEntry = (dir: string, name: string, isDir: boolean, size = 0): FileEntry => ({ name, path: `${dir.replace(/\/$/, "")}/${name}`, isDir, isSymlink: false, size, mtime: 1_735_000_000 });
const mockList = (dir: string): FileEntry[] => [
  mkEntry(dir, "DCIM", true), mkEntry(dir, "Download", true), mkEntry(dir, "Pictures", true), mkEntry(dir, "Music", true),
  mkEntry(dir, "IMG_2041.jpg", false, 3_400_000), mkEntry(dir, "Holiday.mp4", false, 412_000_000), mkEntry(dir, "notes.txt", false, 2_100),
  mkEntry(dir, "backup.zip", false, 88_000_000), mkEntry(dir, "app-release.apk", false, 24_000_000),
];

// ---------- browser mock of the storage backend (same answers the Rust side gives) ----------
const MB = 1_000_000;
const catOf = (n: string): StorageCategory => {
  const e = n.includes(".") ? n.slice(n.lastIndexOf(".") + 1).toLowerCase() : "";
  if (["jpg", "jpeg", "png", "heic", "webp", "gif"].includes(e)) return "images";
  if (["mp4", "mov", "mkv", "webm", "3gp"].includes(e)) return "videos";
  if (["mp3", "m4a", "flac", "wav", "ogg"].includes(e)) return "audio";
  if (["pdf", "doc", "docx", "txt", "xls", "xlsx"].includes(e)) return "documents";
  if (["zip", "rar", "7z", "gz", "tar"].includes(e)) return "archives";
  if (["apk", "xapk", "apks"].includes(e)) return "apps";
  return "other";
};
const mockStorageFiles = (): { path: string; size: number; mtime: number }[] => {
  const f: { path: string; size: number; mtime: number }[] = [];
  const add = (path: string, size: number, mtime = 1_700_000_000) => f.push({ path, size, mtime });
  for (let i = 1; i <= 24; i++) add(`/sdcard/DCIM/Camera/IMG_2024${String(i).padStart(2, "0")}01.jpg`, (3 + (i % 4)) * MB, 1_700_000_000 + i * 86400);
  for (let i = 1; i <= 4; i++) add(`/sdcard/DCIM/Camera/VID_2024${i}.mp4`, (90 + i * 60) * MB, 1_705_000_000 + i * 86400);
  add("/sdcard/Movies/Holiday film.mkv", 1_800 * MB);
  add("/sdcard/Download/big-backup.zip", 1_200 * MB);
  add("/sdcard/Download/IMG_20240101.jpg", 4 * MB, 1_710_000_000); // duplicate of the camera shot
  add("/sdcard/Download/IMG_20240201.jpg", 5 * MB, 1_710_000_100); // duplicate
  add("/sdcard/Download/invoice.pdf", 2 * MB, 1_702_000_000);
  add("/sdcard/Documents/invoice (1).pdf", 2 * MB, 1_702_000_500); // duplicate
  add("/sdcard/Documents/invoice final.pdf", 2 * MB, 1_702_000_900); // duplicate
  for (let i = 1; i <= 12; i++) add(`/sdcard/Music/Track ${i}.mp3`, 5 * MB);
  for (let i = 1; i <= 30; i++) add(`/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/IMG-${i}.jpg`, (150 + i * 20) * 1000);
  add("/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Video/VID-1.mp4", 150 * MB);
  add("/sdcard/Android/obb/com.game.big/main.1.obb", 900 * MB);
  add("/sdcard/notes.txt", 2_100);
  return f;
};
// The same file "contents" are found by name pattern, mirroring what hashing would report.
const MOCK_DUPES: string[][] = [
  ["/sdcard/DCIM/Camera/IMG_20240101.jpg", "/sdcard/Download/IMG_20240101.jpg"],
  ["/sdcard/DCIM/Camera/IMG_20240201.jpg", "/sdcard/Download/IMG_20240201.jpg"],
  ["/sdcard/Download/invoice.pdf", "/sdcard/Documents/invoice (1).pdf", "/sdcard/Documents/invoice final.pdf"],
];
const mockStore = { files: mockStorageFiles(), at: 0 };
const asFile = (f: { path: string; size: number; mtime: number }): StorageFile => ({ ...f, name: f.path.slice(f.path.lastIndexOf("/") + 1), category: catOf(f.path) });
const mockSummary = (): StorageSummary => {
  const cats = (["images", "videos", "audio", "documents", "archives", "apps", "other"] as StorageCategory[]).map((id) => {
    const m = mockStore.files.filter((f) => catOf(f.path) === id);
    return { id, bytes: m.reduce((n, f) => n + f.size, 0), files: m.length };
  }).sort((a, b) => b.bytes - a.bytes);
  return { root: "/sdcard", totalBytes: mockStore.files.reduce((n, f) => n + f.size, 0), totalFiles: mockStore.files.length, categories: cats, finishedMs: mockStore.at, tookMs: 3400 };
};
const mockChildren = (dir: string): TreeNode[] | null => {
  const prefix = dir.replace(/\/$/, "") + "/";
  const inside = mockStore.files.filter((f) => f.path.startsWith(prefix));
  if (!inside.length) return null;
  const by = new Map<string, TreeNode>();
  const kinds = new Map<string, Map<StorageCategory, number>>(); // per folder: bytes by file type
  for (const f of inside) {
    const rest = f.path.slice(prefix.length);
    const i = rest.indexOf("/");
    const name = i < 0 ? rest : rest.slice(0, i);
    const cur = by.get(name) ?? { name, path: prefix + name, size: 0, files: 0, isDir: i >= 0, category: i < 0 ? catOf(name) : null, mtime: i < 0 ? f.mtime : 0 };
    cur.size += f.size; cur.files += 1;
    by.set(name, cur);
    if (i >= 0) {
      const k = kinds.get(name) ?? new Map<StorageCategory, number>();
      k.set(catOf(f.path), (k.get(catOf(f.path)) ?? 0) + f.size);
      kinds.set(name, k);
    }
  }
  // A folder is labelled with the type that takes the most space inside it, like the real backend.
  for (const [name, k] of kinds) by.get(name)!.category = [...k.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return [...by.values()].sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
};
export interface ClipInfo { changeCount: number; files: string[] }
// Deterministic fake library for browser dev/tests: ~600 items over a year, a few albums.
const mockMedia = (): MediaItem[] => {
  const albums = ["Camera", "WhatsApp Images", "Screenshots", "WhatsApp Video"];
  return Array.from({ length: 600 }, (_, i) => {
    const bucket = albums[i % albums.length];
    const video = bucket === "WhatsApp Video" || i % 11 === 0;
    return {
      id: 1000 - i, path: `/sdcard/DCIM/${bucket}/${video ? "VID" : "IMG"}_${String(i).padStart(4, "0")}.${video ? "mp4" : "jpg"}`,
      kind: video ? "video" : "image", mime: video ? "video/mp4" : "image/jpeg", size: 400_000 + i * 9_000,
      dateMs: Date.UTC(2026, 9, 4) - Math.floor(i / 5) * 86_400_000 * 1.7, width: i % 3 === 2 ? 3000 : 4000, height: i % 3 === 2 ? 4000 : 3000, // every third photo is portrait durationMs: video ? 8000 + i * 100 : 0,
      bucket, imported: i % 7 === 0,
    } as MediaItem;
  });
};
const mockThumb = (id: number, label = "") =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='360' height='270'><rect width='100%' height='100%' fill='hsl(${(id * 47) % 360} 45% 55%)'/><text x='50%' y='52%' fill='white' font-family='sans-serif' font-size='28' text-anchor='middle'>${label || id}</text></svg>`)}`;
const mockApps = (): AppInfo[] => {
  const user = [["WhatsApp", "com.whatsapp", 129e6], ["Slack", "com.Slack", 175e6], ["Spotify", "com.spotify.music", 98e6], ["Zapya", "com.dewmobile.kuaiya.play", 58e6], ["Google Maps", "com.google.android.apps.maps", 240e6], ["Notes", "com.example.notes", 12e6]];
  const sys = ["com.android.settings", "com.android.chrome", "com.samsung.android.dialer", "com.google.android.gms", "com.android.systemui", "com.sec.android.app.camera"];
  const mk = (label: string, pkg: string, size: number, system: boolean, i: number): AppInfo => ({
    package: pkg, label: system ? "" : label, icon: null, versionName: `${1 + (i % 5)}.${i}.0`, versionCode: 100 + i, targetSdk: 35, system, disabled: system && i % 4 === 1,
    firstInstall: "2026-04-07 20:42:26", lastUpdate: `2026-09-${String(10 + (i % 18)).padStart(2, "0")} 22:32:56`, installer: system ? "" : "com.android.vending", apkPath: `/data/app/${pkg}/base.apk`,
    appSize: size, dataSize: size / 3, cacheSize: size / 10,
  });
  return [...user.map(([l, p, s], i) => mk(l as string, p as string, s as number, false, i)), ...sys.map((p, i) => mk("", p, 20e6 + i * 5e6, true, i + 10))];
};
const MOCK_LOG = [
  "--------- beginning of main",
  "10-04 17:16:57.672  1234  1234 I ActivityManager: Start proc 4242:com.example.app/u0a238 for top-activity",
  "10-04 17:16:57.801  4242  4242 D ExampleApp: onCreate called",
  "10-04 17:16:58.010  4242  4260 W ExampleApp: slow frame: 48ms",
  "10-04 17:16:58.220  4242  4260 E ExampleApp: failed to load config",
  "10-04 17:16:58.300   999   999 V SurfaceFlinger: vsync tick",
  "10-04 17:16:58.512  1234  1250 F libc    : Fatal signal 6 (SIGABRT)",
  "",
].join("\n");
// Full-size mock photo at its real pixel shape (portrait or landscape), with edge markers so cropping is visible.
const mockFull = (i: MediaItem) => {
  const [w, h] = [i.width / 2, i.height / 2];
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'><rect width='100%' height='100%' fill='hsl(${(i.id * 47) % 360} 45% 55%)'/><rect x='6' y='6' width='${w - 12}' height='${h - 12}' fill='none' stroke='white' stroke-width='12'/><text x='50%' y='50%' fill='white' font-size='${Math.min(w, h) / 6}' text-anchor='middle'>${w > h ? "landscape" : "portrait"}</text></svg>`)}`;
};
const noop = () => Promise.resolve();
// Browser-only mock: record backend calls so e2e tests can assert on them.
const rec = <T,>(name: string, args: unknown, ret: T): Promise<T> => {
  const w = window as unknown as { __calls?: { name: string; args: unknown }[] };
  (w.__calls ??= []).push({ name, args });
  return Promise.resolve(ret);
};

// ---- Webcam mock (browser / Playwright only) ----
// `localStorage["db.mock.webcam"]` can override the prerequisites and force failures, e.g.
// `{"obsInstalled":false,"sdk":30,"camerasFail":true,"startError":"…"}`. Tests drive backend events
// through `window.__webcamEmit("level" | "ended", payload)`.
type WebcamMockFlags = Partial<WebcamPrereqs> & { camerasFail?: boolean; startError?: string };
const webcamFlags = (): WebcamMockFlags => { try { return JSON.parse(localStorage.getItem("db.mock.webcam") ?? "{}") as WebcamMockFlags; } catch { return {}; } };
let mockWebcam: WebcamInfo | null = null;
const webcamBus = { level: new Set<(v: number) => void>(), ended: new Set<(r: string | null) => void>() };
if (typeof window !== "undefined" && !inTauri) {
  (window as unknown as { __webcamEmit: (ev: "level" | "ended", payload: unknown) => void }).__webcamEmit = (ev, payload) => {
    if (ev === "level") webcamBus.level.forEach((f) => f(payload as number));
    else { mockWebcam = null; webcamBus.ended.forEach((f) => f((payload as string | null) ?? null)); }
  };
}
const mockCameras: PhoneCamera[] = [
  { id: "0", facing: "back", width: 4000, height: 3000, fps: [15, 24, 30], sizes: [{ width: 4000, height: 3000 }, { width: 1920, height: 1080 }, { width: 1280, height: 720 }, { width: 640, height: 480 }] },
  { id: "1", facing: "front", width: 1920, height: 1080, fps: [15, 30], sizes: [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }] },
];

export const api = {
  listDir: (serial: string, path: string): Promise<FileEntry[]> => (inTauri ? invoke("list_dir", { serial, path }) : Promise.resolve(mockList(path))),
  listLocal: (path: string): Promise<FileEntry[]> => (inTauri ? invoke("list_local", { path }) : Promise.resolve(mockList(path))),
  devicePlaces: (serial: string): Promise<FileEntry[]> => (inTauri ? invoke("device_places", { serial }) : Promise.resolve(mockList("/sdcard").filter((e) => e.isDir))),
  deviceVolumes: (serial: string): Promise<FileEntry[]> => (inTauri ? invoke("device_volumes", { serial }) : Promise.resolve([])),
  localHome: (): Promise<string> => (inTauri ? invoke("local_home") : Promise.resolve("/Users/demo")),
  deviceMkdir: (serial: string, path: string): Promise<void> => (inTauri ? invoke("device_mkdir", { serial, path }) : rec("deviceMkdir", { path }, undefined)),
  localMkdir: (path: string): Promise<void> => (inTauri ? invoke("local_mkdir", { path }) : noop()),
  deviceRename: (serial: string, from: string, to: string): Promise<void> => (inTauri ? invoke("device_rename", { serial, from, to }) : rec("deviceRename", { from, to }, undefined)),
  localRename: (from: string, to: string): Promise<void> => (inTauri ? invoke("local_rename", { from, to }) : noop()),
  deviceDelete: (serial: string, paths: string[]): Promise<void> => (inTauri ? invoke("device_delete", { serial, paths }) : rec("deviceDelete", { paths }, undefined)),
  localTrash: (paths: string[]): Promise<void> => (inTauri ? invoke("local_trash", { paths }) : noop()),
  checkConflicts: (serial: string, direction: Direction, sources: string[], destDir: string): Promise<string[]> =>
    inTauri ? invoke("check_conflicts", { serial, direction, sources, destDir }) : Promise.resolve([]),
  startTransfer: (req: TransferRequest): Promise<number> => (inTauri ? invoke("start_transfer", { req }) : rec("startTransfer", req, 1)),
  pauseTransfer: (id: number): Promise<void> => (inTauri ? invoke("pause_transfer", { id }) : noop()),
  resumeTransfer: (id: number): Promise<void> => (inTauri ? invoke("resume_transfer", { id }) : noop()),
  cancelTransfer: (id: number): Promise<void> => (inTauri ? invoke("cancel_transfer", { id }) : noop()),
  clearFinishedTransfers: (): Promise<void> => (inTauri ? invoke("clear_finished_transfers") : noop()),
  installApk: (serial: string, path: string): Promise<string> => (inTauri ? invoke("install_apk", { serial, path }) : Promise.resolve("Installed")),
  revealInFinder: (path: string): Promise<void> => (inTauri ? invoke("reveal_in_finder", { path }) : noop()),
  openLocal: (path: string): Promise<void> => (inTauri ? invoke("open_local", { path }) : noop()),
  previewDevice: (serial: string, path: string, open: boolean): Promise<void> => (inTauri ? invoke("preview_device_file", { serial, path, open }) : noop()),
  previewLocal: (path: string): Promise<void> => (inTauri ? invoke("preview_local_file", { path }) : noop()),
  clipboardWrite: (serial: string | null, items: { path: string; isDir: boolean }[]): Promise<number> => (inTauri ? invoke("clipboard_write", { serial, items }) : Promise.resolve(-1)),
  backupFolders: (serial: string): Promise<BackupFolder[]> =>
    inTauri ? invoke("backup_folders", { serial }) : Promise.resolve([
      { path: "/sdcard/DCIM", label: "DCIM", recommended: true }, { path: "/sdcard/Pictures", label: "Pictures", recommended: true },
      { path: "/sdcard/Android/media/com.whatsapp", label: "WhatsApp media", recommended: true }, { path: "/sdcard/Download", label: "Download", recommended: true },
      { path: "/sdcard/Podcasts", label: "Podcasts", recommended: false }]),
  backupFolderSize: (serial: string, path: string): Promise<number> => (inTauri ? invoke("backup_folder_size", { serial, path }) : Promise.resolve(path.length * 40_000_000)),
  backupEncryptedStatus: (destRoot: string, deviceName: string, serial: string): Promise<EncryptedStatus> =>
    inTauri ? invoke("backup_encrypted_status", { destRoot, deviceName, serial }) : Promise.resolve({ exists: false, hasPassword: false, path: "" }),
  backupRun: (req: BackupRequest): Promise<BackupSummary> =>
    inTauri ? invoke("backup_run", { req }) : rec("backupRun", req, { dest: req.destRoot, filesCopied: 12, filesSkipped: 0, bytes: 5e6, apps: 3, errors: [], canceled: false, startedMs: 1, finishedMs: 2, encrypted: req.encrypt }),
  backupCancel: (): Promise<void> => (inTauri ? invoke("backup_cancel") : rec("backupCancel", {}, undefined)),
  backupRunning: (): Promise<boolean> => (inTauri ? invoke("backup_running") : Promise.resolve(false)),
  backupHistory: (serial: string): Promise<BackupRecord[]> =>
    inTauri ? invoke("backup_history", { serial }) : Promise.resolve([{ id: 1, device: "Pixel 8 Pro", dest: "/Users/demo/Droid Shuttle Backups/Pixel 8 Pro (MOCK)", startedMs: Date.now() - 3 * 86_400_000, finishedMs: Date.now() - 3 * 86_400_000 + 90_000, filesCopied: 1204, filesSkipped: 0, bytes: 12.4e9, apps: 31, errors: 0, folders: ["/sdcard/DCIM"] }]),
  backupOpen: (path: string, password?: string): Promise<OpenedBackup> =>
    inTauri ? invoke("backup_open", { path, password: password ?? null }) : Promise.resolve({ root: path, mounted: false, contents: { folders: [{ rel: "DCIM", bytes: 9e9, files: 800 }, { rel: "Android/media/com.whatsapp", bytes: 3e9, files: 4000 }], apps: [{ package: "com.whatsapp", label: "WhatsApp", versionName: "2.26", dir: "com.whatsapp-2.26", bytes: 129e6 }] } }),
  backupClose: (root: string): Promise<void> => (inTauri ? invoke("backup_close", { root }) : noop()),
  backupRestoreFiles: (req: { serial: string; root: string; folders: string[]; destBase: string; conflict: Conflict }): Promise<number> => (inTauri ? invoke("backup_restore_files", { req }) : rec("backupRestoreFiles", req, 1)),
  backupRestoreApps: (serial: string, root: string, dirs: string[]): Promise<InstallOutcome[]> =>
    inTauri ? invoke("backup_restore_apps", { serial, root, dirs }) : rec("backupRestoreApps", { dirs }, dirs.map((d) => ({ file: d, ok: true, message: "Installed" }))),
  onBackupStage: (cb: (s: { stage: string; detail: string }) => void) => (inTauri ? listen<{ stage: string; detail: string }>("backup-stage", (e) => cb(e.payload)) : Promise.resolve(() => {})),
  shellStart: async (serial: string, cols: number, rows: number, onOut: (b: ArrayBuffer) => void): Promise<number> => {
    if (!inTauri) {
      const emit = (t: string) => onOut(new Uint8Array([1, ...new TextEncoder().encode(t)]).buffer);
      (window as unknown as { __shellEmit?: (t: string) => void }).__shellEmit = emit;
      void rec("shellStart", { cols, rows }, 7);
      setTimeout(() => emit("mock:/ $ "), 0);
      return 7;
    }
    const ch = new Channel<ArrayBuffer>();
    ch.onmessage = onOut;
    return invoke("shell_start", { serial, cols, rows, onOut: ch });
  },
  shellWrite: (id: number, data: Uint8Array): Promise<void> => {
    if (!inTauri) { (window as unknown as { __shellEmit?: (t: string) => void }).__shellEmit?.(new TextDecoder().decode(data)); return rec("shellWrite", { text: new TextDecoder().decode(data) }, undefined); }
    return invoke("shell_write", { id, data: Array.from(data) });
  },
  shellResize: (id: number, cols: number, rows: number): Promise<void> => (inTauri ? invoke("shell_resize", { id, cols, rows }) : rec("shellResize", { cols, rows }, undefined)),
  shellClose: (id: number): Promise<void> => (inTauri ? invoke("shell_close", { id }) : rec("shellClose", {}, undefined)),
  logcatStart: async (serial: string, clear: boolean, onLines: (text: string) => void): Promise<void> => {
    if (!inTauri) {
      (window as unknown as { __logPush?: (t: string) => void }).__logPush = onLines;
      void rec("logcatStart", { clear }, undefined);
      onLines(MOCK_LOG);
      return;
    }
    const ch = new Channel<ArrayBuffer>();
    const dec = new TextDecoder();
    ch.onmessage = (b) => onLines(dec.decode(b));
    return invoke("logcat_start", { serial, clear, onLines: ch });
  },
  logcatStop: (): Promise<void> => (inTauri ? invoke("logcat_stop") : rec("logcatStop", {}, undefined)),
  logcatClear: (serial: string): Promise<void> => (inTauri ? invoke("logcat_clear", { serial }) : rec("logcatClear", {}, undefined)),
  pidsOfPackage: (serial: string, pkg: string): Promise<number[]> => (inTauri ? invoke("pids_of_package", { serial, package: pkg }) : rec("pidsOfPackage", { pkg }, [4242])),
  deviceStatus: (serial: string): Promise<DeviceStatus> =>
    inTauri ? invoke("device_status", { serial }) : Promise.resolve({
      batteryLevel: 82, batteryStatus: "Charging", batteryHealth: "Good", batteryTempC: 31.2, batteryVoltageMv: 4311, plugged: "USB", memTotal: 8e9, memAvailable: 3.2e9,
      storageTotal: 128e9, storageUsed: 71e9, uptimeSecs: 93_784, model: "Pixel 8 Pro", manufacturer: "Google", android: "15", sdk: 35, securityPatch: "2026-09-05",
      build: "AP3A.240905.015", abi: "arm64-v8a", screen: "1080x2400", density: "420", wifiIp: "192.168.1.37", kernel: "Linux 6.1.99" }),
  wifiMdns: (): Promise<MdnsService[]> => (inTauri ? invoke("wifi_mdns") : Promise.resolve([{ name: "adb-MOCK-abc", kind: "_adb-tls-connect._tcp", address: "192.168.1.37:37099" }, { name: "studio-xyz", kind: "_adb-tls-pairing._tcp", address: "192.168.1.37:41201" }])),
  wifiPair: (hostPort: string, code: string): Promise<string> => (inTauri ? invoke("wifi_pair", { hostPort, code }) : rec("wifiPair", { hostPort, code }, "Successfully paired")),
  wifiConnect: (hostPort: string): Promise<string> => (inTauri ? invoke("wifi_connect", { hostPort }) : rec("wifiConnect", { hostPort }, `connected to ${hostPort}`)),
  wifiDisconnect: (hostPort: string): Promise<void> => (inTauri ? invoke("wifi_disconnect", { hostPort }) : rec("wifiDisconnect", { hostPort }, undefined)),
  wifiGoWireless: (serial: string): Promise<string> => (inTauri ? invoke("wifi_go_wireless", { serial }) : rec("wifiGoWireless", { serial }, "192.168.1.37:5555")),
  wifiQr: (): Promise<QrInfo> => (inTauri ? invoke("wifi_qr") : Promise.resolve({ name: "studio-abc", password: "123456789012", payload: "WIFI:T:ADB;S:studio-abc;P:123456789012;;" })),
  wifiQrFinish: (name: string, password: string, timeoutSecs: number): Promise<string> => (inTauri ? invoke("wifi_qr_finish", { name, password, timeoutSecs }) : rec("wifiQrFinish", { name, password }, "192.168.1.37:37099").then(() => new Promise<string>(() => {}))), // pends, like waiting for a real scan
  saveText: (path: string, content: string): Promise<void> => (inTauri ? invoke("save_text", { path, content }) : rec("saveText", { path, len: content.length }, undefined)),
  mirrorStart: async (serial: string, opts: MirrorOptions, onVideo: (b: ArrayBuffer) => void): Promise<{ deviceName: string }> => {
    if (!inTauri) { (window as unknown as { __calls?: unknown[] }).__calls ??= []; ((window as unknown as { __calls: unknown[] }).__calls).push({ name: "mirrorStart", args: opts }); return { deviceName: "Pixel 8 Pro" }; }
    const ch = new Channel<ArrayBuffer>();
    ch.onmessage = onVideo;
    return invoke("mirror_start", { serial, opts, onVideo: ch });
  },
  mirrorInput: (input: MirrorInput): Promise<void> => (inTauri ? invoke("mirror_input", { input }) : rec("mirrorInput", input, undefined)),
  mirrorStop: (): Promise<void> => (inTauri ? invoke("mirror_stop") : rec("mirrorStop", {}, undefined)),
  phoneScreenshot: (serial: string, destDir: string): Promise<string> => (inTauri ? invoke("phone_screenshot", { serial, destDir }) : rec("phoneScreenshot", { destDir }, `${destDir}/Screenshot.png`)),
  recordStart: (serial: string, bitRateMbps: number): Promise<void> => (inTauri ? invoke("record_start", { serial, bitRateMbps }) : rec("recordStart", { bitRateMbps }, undefined)),
  recordStop: (destDir: string): Promise<string> => (inTauri ? invoke("record_stop", { destDir }) : rec("recordStop", { destDir }, `${destDir}/Screen Recording.mp4`)),
  onMirrorEnded: (cb: (reason: string | null) => void) => (inTauri ? listen<string | null>("mirror-ended", (e) => cb(e.payload)) : Promise.resolve(() => {})),
  onMirrorClipboard: (cb: (text: string) => void) => (inTauri ? listen<string>("mirror-clipboard", (e) => cb(e.payload)) : Promise.resolve(() => {})),
  webcamPrereqs: (serial: string): Promise<WebcamPrereqs> =>
    inTauri ? invoke("webcam_prereqs", { serial }) : rec("webcamPrereqs", { serial }, { obsInstalled: true, blackholeInstalled: true, sdk: 35, cameraSupported: true, micSupported: true, ...webcamFlags() }),
  webcamListCameras: (serial: string): Promise<PhoneCamera[]> =>
    inTauri ? invoke("webcam_list_cameras", { serial }) : webcamFlags().camerasFail ? Promise.reject(new Error("Couldn't list the phone's cameras.")) : rec("webcamListCameras", { serial }, mockCameras),
  webcamAudioDevices: (): Promise<AudioDevice[]> =>
    inTauri ? invoke("webcam_audio_devices") : rec("webcamAudioDevices", {}, [
      ...(webcamFlags().blackholeInstalled === false ? [] : [{ name: "BlackHole 2ch", isBlackhole: true, supports48k: true }]),
      { name: "MacBook Pro Speakers", isBlackhole: false, supports48k: true },
    ]),
  webcamStart: async (serial: string, opts: CameraOptions): Promise<WebcamInfo> => {
    if (inTauri) return invoke("webcam_start", { serial, opts });
    await rec("webcamStart", opts, undefined);
    const bad = webcamFlags().startError;
    if (bad) throw new Error(bad);
    const port = opts.port || 5400;
    return (mockWebcam = { deviceName: "Galaxy A07", obsUrl: `tcp://127.0.0.1:${port}`, port, micActive: opts.mic, micNote: null, outputDevice: opts.mic ? "BlackHole 2ch" : null });
  },
  webcamStop: async (): Promise<void> => {
    if (inTauri) return invoke("webcam_stop");
    mockWebcam = null;
    return rec("webcamStop", {}, undefined);
  },
  /** Retune the mic delay while the camera is on. Resolves false when no mic is playing. */
  webcamSetDelay: (delayMs: number): Promise<boolean> => (inTauri ? invoke("webcam_set_delay", { delayMs }) : rec("webcamSetDelay", { delayMs }, true)),
  webcamStatus: (): Promise<WebcamInfo | null> => (inTauri ? invoke("webcam_status") : Promise.resolve(mockWebcam)),
  /** Live preview frames: same `[kind u8][pts u64][payload]` messages as `mirrorStart`. */
  webcamAttachPreview: async (onVideo: (b: ArrayBuffer) => void): Promise<void> => {
    if (!inTauri) return rec("webcamAttachPreview", {}, undefined);
    const ch = new Channel<ArrayBuffer>();
    ch.onmessage = onVideo;
    return invoke("webcam_attach_preview", { onVideo: ch });
  },
  webcamDetachPreview: (): Promise<void> => (inTauri ? invoke("webcam_detach_preview") : rec("webcamDetachPreview", {}, undefined)),
  onWebcamEnded: (cb: (reason: string | null) => void) =>
    inTauri ? listen<string | null>("webcam-ended", (e) => cb(e.payload)) : (webcamBus.ended.add(cb), Promise.resolve(() => { webcamBus.ended.delete(cb); })),
  /** Microphone level 0..1 (RMS), about ten times a second while the mic is live. */
  onWebcamLevel: (cb: (level: number) => void) =>
    inTauri ? listen<number>("webcam-level", (e) => cb(e.payload)) : (webcamBus.level.add(cb), Promise.resolve(() => { webcamBus.level.delete(cb); })),
  appsList: (serial: string): Promise<AppInfo[]> => (inTauri ? invoke("apps_list", { serial }) : Promise.resolve(mockApps())),
  appsResolve: (serial: string, items: { package: string; apkPath: string; versionCode: number }[]): Promise<number> => (inTauri ? invoke("apps_resolve", { serial, items }) : rec("appsResolve", items, items.length)),
  appDetails: (serial: string, pkg: string): Promise<AppDetails> =>
    inTauri ? invoke("app_details", { serial, package: pkg }) : Promise.resolve({ apkPaths: [`/data/app/${pkg}/base.apk`], granted: ["POST_NOTIFICATIONS", "CAMERA"], denied: ["READ_CALL_LOG", "SEND_SMS"] }),
  appUninstall: (serial: string, pkg: string, keepData: boolean, system: boolean): Promise<void> => (inTauri ? invoke("app_uninstall", { serial, package: pkg, keepData, system }) : rec("appUninstall", { pkg, keepData, system }, undefined)),
  appSetEnabled: (serial: string, pkg: string, enabled: boolean): Promise<void> => (inTauri ? invoke("app_set_enabled", { serial, package: pkg, enabled }) : rec("appSetEnabled", { pkg, enabled }, undefined)),
  appClearData: (serial: string, pkg: string): Promise<void> => (inTauri ? invoke("app_clear_data", { serial, package: pkg }) : rec("appClearData", { pkg }, undefined)),
  appForceStop: (serial: string, pkg: string): Promise<void> => (inTauri ? invoke("app_force_stop", { serial, package: pkg }) : rec("appForceStop", { pkg }, undefined)),
  appLaunch: (serial: string, pkg: string): Promise<void> => (inTauri ? invoke("app_launch", { serial, package: pkg }) : rec("appLaunch", { pkg }, undefined)),
  appOpenSettings: (serial: string, pkg: string): Promise<void> => (inTauri ? invoke("app_open_settings", { serial, package: pkg }) : rec("appOpenSettings", { pkg }, undefined)),
  appExtract: (serial: string, a: AppInfo, destDir: string): Promise<number> =>
    inTauri ? invoke("app_extract", { serial, package: a.package, label: a.label, version: a.versionName, destDir }) : rec("appExtract", { pkg: a.package, destDir }, 1),
  appsInstall: (serial: string, paths: string[]): Promise<InstallOutcome[]> =>
    inTauri ? invoke("apps_install", { serial, paths }) : rec("appsInstall", { paths }, paths.map((p) => ({ file: p.split("/").pop() ?? p, ok: true, message: "Installed" }))),
  onAppMeta: (cb: (m: { package: string; label: string; icon: string | null }) => void) =>
    inTauri ? listen<{ package: string; label: string; icon: string | null }>("app-meta", (e) => cb(e.payload)) : Promise.resolve(() => {}),
  mediaScan: (serial: string): Promise<number> => (inTauri ? invoke("media_scan", { serial }) : Promise.resolve(600)),
  mediaList: (serial: string): Promise<MediaItem[]> => (inTauri ? invoke("media_list", { serial }) : Promise.resolve(mockMedia())),
  mediaThumb: (serial: string, i: MediaItem, fast: boolean): Promise<string> =>
    inTauri ? invoke("media_thumb", { serial, req: { id: i.id, path: i.path, kind: i.kind, size: i.size }, fast }) : fast ? Promise.reject("no fast preview") : new Promise((r) => setTimeout(() => r(mockThumb(i.id)), 30)),
  mediaOpen: (serial: string, i: MediaItem): Promise<string> =>
    inTauri ? invoke("media_open", { serial, path: i.path, kind: i.kind, size: i.size }) : Promise.resolve(mockFull(i)),
  mediaInfo: (serial: string, path: string): Promise<MediaInfo> =>
    inTauri ? invoke("media_info", { serial, path }) : Promise.resolve({ camera: "Google Pixel 8 Pro", lens: null, taken: "2026-10-04 12:26:11", exposure: "1/120 s", aperture: "f/1.9", iso: "64", focalLength: "6.9 mm", software: null, latitude: 51.5, longitude: -0.12 }),
  mediaImport: (a: { serial: string; items: { path: string; bucket: string; dateMs: number }[]; destDir: string; organize: Organize; deleteAfter: boolean }): Promise<number> =>
    inTauri ? invoke("media_import", a) : rec("mediaImport", a, 1),
  onMediaChanged: (cb: () => void) => (inTauri ? listen("media-changed", () => cb()) : Promise.resolve(() => {})),
  clipboardStage: (serial: string, items: { path: string; isDir: boolean }[]): Promise<number> => (inTauri ? invoke("clipboard_stage", { serial, items }) : rec("clipboardStage", { items }, -1)),
  clipboardRead: (): Promise<ClipInfo> => (inTauri ? invoke("clipboard_read") : Promise.resolve({ changeCount: -1, files: [] })),
  nativeDrag: (serial: string | null, items: { path: string; isDir: boolean }[]): Promise<void> => (inTauri ? invoke("native_drag", { serial, items }) : noop()),
  storageScan: async (serial: string, root?: string): Promise<StorageSummary> => {
    if (inTauri) return invoke("storage_scan", { serial, root: root ?? null });
    await new Promise((r) => setTimeout(r, 500));
    mockStore.files = mockStorageFiles();
    mockStore.at = Date.now();
    return mockSummary();
  },
  storageCancel: (): Promise<void> => (inTauri ? invoke("storage_cancel") : rec("storageCancel", {}, undefined)),
  storageSummary: (serial: string): Promise<StorageSummary | null> => (inTauri ? invoke("storage_summary", { serial }) : Promise.resolve(mockStore.at ? mockSummary() : null)),
  storageChildren: (serial: string, path: string): Promise<TreeNode[] | null> => (inTauri ? invoke("storage_children", { serial, path }) : Promise.resolve(mockChildren(path))),
  storageLargest: (serial: string, category: StorageCategory | null, minSize: number, limit: number): Promise<StorageFile[]> =>
    inTauri
      ? invoke("storage_largest", { serial, category, minSize, limit })
      : Promise.resolve(mockStore.files.filter((f) => f.size >= minSize && (!category || catOf(f.path) === category)).sort((a, b) => b.size - a.size).slice(0, limit).map(asFile)),
  storageDuplicates: async (serial: string, minSize: number): Promise<DupGroup[]> => {
    if (inTauri) return invoke("storage_duplicates", { serial, minSize });
    await new Promise((r) => setTimeout(r, 400));
    const byPath = new Map(mockStore.files.map((f) => [f.path, f]));
    return MOCK_DUPES.map((paths) => paths.map((p) => byPath.get(p)).filter((f): f is NonNullable<typeof f> => !!f && f.size >= minSize).map(asFile))
      .filter((g) => g.length > 1)
      .map((files) => ({ size: files[0].size, hash: files[0].path, files }));
  },
  storageForget: async (serial: string, paths: string[]): Promise<StorageSummary | null> => {
    if (inTauri) return invoke("storage_forget", { serial, paths });
    mockStore.files = mockStore.files.filter((f) => !paths.some((p) => f.path === p || f.path.startsWith(p + "/")));
    return mockSummary();
  },
  onStorageProgress: (cb: (p: StorageProgress) => void) => {
    if (inTauri) return listen<StorageProgress>("storage-progress", (e) => cb(e.payload));
    (window as unknown as { __storageProgress?: typeof cb }).__storageProgress = cb; // lets browser tests simulate a long scan
    return Promise.resolve(() => {});
  },
  /** The menu-bar item asked to open a screen. */
  onTrayNavigate: (cb: (section: string) => void) => (inTauri ? listen<string>("tray-navigate", (e) => cb(e.payload)) : Promise.resolve(() => {})),
  onTransferUpdate: (cb: (s: TransferSnapshot) => void) => {
    if (inTauri) return listen<TransferSnapshot>("transfer-update", (e) => cb(e.payload));
    (window as unknown as { __emitTransfer?: typeof cb }).__emitTransfer = cb; // lets browser tests simulate backend progress
    return Promise.resolve(() => {});
  },
  listDevices: (): Promise<AdbDevice[]> => (inTauri ? invoke("list_devices") : Promise.resolve([mockDevice])),
  deviceInfo: (serial: string): Promise<DeviceInfo> => (inTauri ? invoke("device_info", { serial }) : Promise.resolve(mockInfo)),
  onDevicesChanged: (cb: (d: AdbDevice[]) => void) =>
    inTauri ? listen<AdbDevice[]>("devices-changed", (e) => cb(e.payload)) : Promise.resolve(() => {}),
  onAdbError: (cb: (msg: string) => void) =>
    inTauri ? listen<string>("adb-error", (e) => cb(e.payload)) : Promise.resolve(() => {}),
};

export const formatDate = (unix: number) =>
  unix ? new Date(unix * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";

export const toSrc = (p: string) => (p.startsWith("data:") ? p : convertFileSrc(p));

export const formatBytes = (n: number) => {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1000)));
  return `${(n / 1000 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};
