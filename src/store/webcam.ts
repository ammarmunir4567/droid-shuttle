import { create } from "zustand";
import { api, type AudioDevice, type CameraOptions, type PhoneCamera, type WebcamInfo, type WebcamPrereqs } from "../lib/api";
import { STORAGE_KEY, normalizeOptions, selectedCamera } from "../features/webcam/helpers";
import { useUi } from "./ui";

const load = (): CameraOptions => { try { return normalizeOptions(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")); } catch { return normalizeOptions({}); } };
const save = (o: CameraOptions) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(o)); } catch { /* storage unavailable */ } };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toast = (kind: "info" | "ok" | "error", text: string, ms = 4500) => useUi.getState().toast({ kind, text }, ms);

interface WebcamStore {
  options: CameraOptions;
  /** Set while the camera is on. It outlives the Webcam screen: the call app keeps using it. */
  info: WebcamInfo | null;
  starting: boolean;
  error: string | null;
  /** Mic level 0..1 (only meaningful while `info` is set). */
  level: number;
  prereqs: WebcamPrereqs | null;
  /** null = not loaded yet; [] = loaded but none found (or listing failed, see `camerasFailed`). */
  cameras: PhoneCamera[] | null;
  camerasFailed: boolean;
  devices: AudioDevice[];
  checking: boolean;
  /** The phone the lists above belong to. */
  loadedFor: string | null;

  /** Call once from the app root. Subscribes to backend events and picks up a session that's already running. Returns the cleanup. */
  init: () => () => void;
  setOption: <K extends keyof CameraOptions>(k: K, v: CameraOptions[K]) => void;
  setOptions: (o: CameraOptions) => void;
  start: (serial: string) => Promise<void>;
  stop: () => Promise<void>;
  /** Re-read prerequisites, cameras and audio devices. Cameras are left alone while the camera is on (listing would fight the live session). */
  refresh: (serial: string, force?: boolean) => Promise<void>;
  clearError: () => void;
}

export const useWebcam = create<WebcamStore>((set, get) => ({
  options: load(),
  info: null,
  starting: false,
  error: null,
  level: 0,
  prereqs: null,
  cameras: null,
  camerasFailed: false,
  devices: [],
  checking: false,
  loadedFor: null,

  init: () => {
    let alive = true;
    const un = [
      api.onWebcamEnded((reason) => {
        if (!alive) return;
        set({ info: null, starting: false, level: 0, error: reason ?? null });
        toast(reason ? "error" : "info", reason ? `Webcam stopped: ${reason}` : "Webcam stopped", reason ? 8000 : 4500);
      }),
      api.onWebcamLevel((level) => { if (alive) set({ level }); }),
    ];
    // After a reload the backend may still be running a session.
    api.webcamStatus().then((info) => { if (alive && info) set({ info }); }).catch(() => {});
    return () => { alive = false; un.forEach((p) => void p.then((f) => f())); };
  },

  setOption: (k, v) => get().setOptions({ ...get().options, [k]: v }),
  setOptions: (options) => { const o = normalizeOptions(options); save(o); set({ options: o }); },

  start: async (serial) => {
    const { starting, info, prereqs, options, cameras } = get();
    if (starting || info) return;
    set({ starting: true, error: null });
    const base = normalizeOptions(options);
    // When the phone's camera list is known, name the exact camera the picker shows instead of leaving
    // the backend to resolve "first camera facing …". (Stored options keep the user's own choice.)
    const cam = selectedCamera(base, cameras ?? []);
    // A phone older than Android 11 can't give us the mic; ask for the camera only instead of failing.
    const opts: CameraOptions = { ...base, cameraId: cam?.id ?? base.cameraId, mic: base.mic && (prereqs?.micSupported ?? true) };
    try {
      set({ info: await api.webcamStart(serial, opts), level: 0 });
    } catch (e) {
      set({ error: message(e) });
    } finally {
      set({ starting: false });
    }
  },

  stop: async () => {
    try {
      await api.webcamStop();
    } catch (e) {
      set({ error: message(e) });
    } finally {
      set({ info: null, level: 0, starting: false });
    }
  },

  refresh: async (serial, force = false) => {
    const s = get();
    if (s.checking) return;
    const running = s.info !== null;
    const needCameras = !running && (force || s.loadedFor !== serial || s.cameras === null);
    set({ checking: true });
    const [pre, cams, devs] = await Promise.allSettled([api.webcamPrereqs(serial), needCameras ? api.webcamListCameras(serial) : Promise.resolve(null), api.webcamAudioDevices()]);
    set({
      checking: false,
      loadedFor: serial,
      prereqs: pre.status === "fulfilled" ? pre.value : s.prereqs,
      devices: devs.status === "fulfilled" ? devs.value : s.devices,
      ...(cams.status === "fulfilled" ? (cams.value ? { cameras: cams.value, camerasFailed: false } : {}) : { cameras: [], camerasFailed: true }),
    });
  },

  clearError: () => set({ error: null }),
}));
