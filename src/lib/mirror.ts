// Screen-mirroring client: decodes the phone's H.264 stream with WebCodecs and maps Mac input
// (pointer, wheel, keyboard) to Android input events.

export const KEY = { HOME: 3, BACK: 4, VOLUME_UP: 24, VOLUME_DOWN: 25, POWER: 26, TAB: 61, SPACE: 62, ENTER: 66, DEL: 67, MENU: 82, PAGE_UP: 92, PAGE_DOWN: 93, FORWARD_DEL: 112, MOVE_HOME: 122, MOVE_END: 123, DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22, APP_SWITCH: 187 } as const;
export const ACTION = { DOWN: 0, UP: 1, MOVE: 2 } as const;

/** WebCodecs codec string (`avc1.PPCCLL`) from an Annex-B SPS, e.g. `avc1.64002a`. */
export function codecFromSps(config: Uint8Array): string | null {
  for (let i = 0; i + 4 < config.length; i++) {
    const sc3 = config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1;
    const sc4 = config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 0 && config[i + 3] === 1;
    if (!sc3 && !sc4) continue;
    const n = i + (sc4 ? 4 : 3);
    if ((config[n] & 0x1f) === 7 && n + 3 < config.length) {
      const h = (b: number) => b.toString(16).padStart(2, "0");
      return `avc1.${h(config[n + 1])}${h(config[n + 2])}${h(config[n + 3])}`;
    }
  }
  return null;
}

/** Position inside the displayed canvas → pixel in the phone's frame (clamped). */
export function mapPoint(rect: { left: number; top: number; width: number; height: number }, frameW: number, frameH: number, clientX: number, clientY: number) {
  const fx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const fy = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  return { x: Math.min(frameW - 1, Math.round(fx * frameW)), y: Math.min(frameH - 1, Math.round(fy * frameH)) };
}

const SPECIAL: Record<string, number> = {
  Enter: KEY.ENTER, Backspace: KEY.DEL, Tab: KEY.TAB, Escape: KEY.BACK, Delete: KEY.FORWARD_DEL,
  ArrowUp: KEY.DPAD_UP, ArrowDown: KEY.DPAD_DOWN, ArrowLeft: KEY.DPAD_LEFT, ArrowRight: KEY.DPAD_RIGHT,
  Home: KEY.MOVE_HOME, End: KEY.MOVE_END, PageUp: KEY.PAGE_UP, PageDown: KEY.PAGE_DOWN,
};

export type KeyPlan =
  | { kind: "key"; keycode: number }
  | { kind: "text"; text: string }
  | { kind: "shortcut"; name: "home" | "back" | "recents" | "power" | "volUp" | "volDown" | "screenOff" | "rotate" | "notifications" | "settings" }
  | null;

/** What a keyboard event should do on the phone. ⌥-combos are mirroring shortcuts (like scrcpy's MOD). */
export function planKey(e: { key: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; code: string }): KeyPlan {
  if (e.altKey && !e.metaKey && !e.ctrlKey) {
    const k = e.code;
    if (k === "KeyH") return { kind: "shortcut", name: "home" };
    if (k === "KeyB") return { kind: "shortcut", name: "back" };
    if (k === "KeyS") return { kind: "shortcut", name: "recents" };
    if (k === "KeyP") return { kind: "shortcut", name: "power" };
    if (k === "KeyO") return { kind: "shortcut", name: "screenOff" };
    if (k === "KeyR") return { kind: "shortcut", name: "rotate" };
    if (k === "KeyN") return { kind: "shortcut", name: e.shiftKey ? "settings" : "notifications" };
    if (k === "ArrowUp") return { kind: "shortcut", name: "volUp" };
    if (k === "ArrowDown") return { kind: "shortcut", name: "volDown" };
    return null;
  }
  if (e.metaKey || e.ctrlKey) return null; // ⌘C/⌘V etc. belong to the Mac (paste is handled separately)
  if (SPECIAL[e.key] !== undefined) return { kind: "key", keycode: SPECIAL[e.key] };
  if (e.key.length === 1) return { kind: "text", text: e.key };
  return null;
}

export type Stats = { fps: number; width: number; height: number; decoded: number; dropped: number };

/** H.264 (Annex B) → canvas. Feed it the binary messages from the backend. */
export class H264Player {
  private decoder: VideoDecoder | null = null;
  private pendingConfig: Uint8Array | null = null;
  private ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  decoded = 0;
  dropped = 0;
  private tick = { t: performance.now(), n: 0, fps: 0 };
  onSize?: (w: number, h: number) => void;
  onError?: (msg: string) => void;
  onFirstFrame?: () => void;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
  }

  static supported() {
    return typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";
  }

  /** `[kind u8][pts u64][payload]` — see `mirror_start` in the backend. */
  push(buf: ArrayBuffer) {
    const dv = new DataView(buf);
    const kind = dv.getUint8(0);
    const pts = Number(dv.getBigUint64(1));
    const payload = new Uint8Array(buf, 9);
    if (kind === 0) {
      this.width = dv.getUint32(9);
      this.height = dv.getUint32(13);
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      this.onSize?.(this.width, this.height);
    } else if (kind === 1) {
      this.configure(payload);
    } else if ((kind === 2 || kind === 3) && this.decoder?.state === "configured") {
      if (this.decoder.decodeQueueSize > 6 && kind === 3) { this.dropped++; return; } // fall behind → skip deltas until the next key frame
      let data = payload;
      if (this.pendingConfig) {
        // The encoder sends SPS/PPS separately; decoders want them in front of the first key frame.
        const merged = new Uint8Array(this.pendingConfig.length + payload.length);
        merged.set(this.pendingConfig, 0);
        merged.set(payload, this.pendingConfig.length);
        data = merged;
        this.pendingConfig = null;
      }
      try {
        this.decoder.decode(new EncodedVideoChunk({ type: kind === 2 ? "key" : "delta", timestamp: pts, data }));
      } catch (e) { this.onError?.(String(e)); }
    }
  }

  private configure(config: Uint8Array) {
    const codec = codecFromSps(config);
    if (!codec) return this.onError?.("The phone sent an unexpected video format.");
    if (!H264Player.supported()) return this.onError?.("This version of macOS can't decode video in the app window.");
    this.decoder?.close();
    this.pendingConfig = config.slice();
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
        frame.close();
        if (this.decoded++ === 0) this.onFirstFrame?.();
        this.tick.n++;
        const now = performance.now();
        if (now - this.tick.t >= 1000) { this.tick.fps = Math.round((this.tick.n * 1000) / (now - this.tick.t)); this.tick.n = 0; this.tick.t = now; }
      },
      error: (e) => this.onError?.(`Video decoder: ${e.message}`),
    });
    this.decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
  }

  stats(): Stats { return { fps: this.tick.fps, width: this.width, height: this.height, decoded: this.decoded, dropped: this.dropped }; }
  close() { try { this.decoder?.close(); } catch { /* already closed */ } this.decoder = null; }
}
