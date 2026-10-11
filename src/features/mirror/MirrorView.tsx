import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import clsx from "clsx";
import { AlertTriangle, ArrowLeft, Bell, Camera, Circle, Home, Loader2, Maximize2, Minimize2, MonitorSmartphone, Pin, Power, RotateCw, Square, SquareStack, Sun, Volume1, Volume2, X } from "lucide-react";
import { api, inTauri, type MirrorInput, type MirrorOptions } from "../../lib/api";
import { ACTION, H264Player, KEY, mapPoint, planKey } from "../../lib/mirror";
import { currentSerial } from "../../lib/ops";
import { useDevices } from "../../store/devices";
import { useUi } from "../../store/ui";

const toast = (kind: "info" | "ok" | "error", text: string, ms = 4500) => useUi.getState().toast({ kind, text }, ms);
const KEY_OPTS = "db.m.opts";
const DEFAULTS: MirrorOptions = { maxSize: 1280, bitRateMbps: 8, maxFps: 0, screenOff: false, showTouches: false, stayAwake: true };
const loadOpts = (): MirrorOptions => { try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY_OPTS) ?? "{}") as Partial<MirrorOptions>) }; } catch { return DEFAULTS; } };
const RESOLUTIONS: [number, string][] = [[0, "Native"], [1920, "High"], [1280, "Balanced"], [800, "Low"]];
const home = async () => api.localHome();

type Phase = "idle" | "starting" | "live";

function Tool({ label, onClick, children, on, danger }: { label: string; onClick: () => void; children: React.ReactNode; on?: boolean; danger?: boolean }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className={clsx("grid size-9 place-items-center rounded-lg hover:bg-[var(--hover)]", on && "bg-[var(--selected)] text-[var(--color-accent)]", danger && "text-[var(--color-danger)]")}>{children}</button>
  );
}
const Sep = () => <div className="my-1 h-px w-6 self-center" style={{ background: "var(--border)" }} />;

export function MirrorView() {
  const serial = useDevices((s) => s.selected)!;
  const deviceName = useDevices((s) => s.devices.find((d) => d.serial === s.selected)?.model ?? "your phone");
  const [opts, setOpts] = useState<MirrorOptions>(loadOpts);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [fps, setFps] = useState(0);
  const [showStats, setShowStats] = useState(false);
  const [recording, setRecording] = useState<number | null>(null); // seconds elapsed
  const [onTop, setOnTop] = useState(false);
  const [full, setFull] = useState(false);
  const [screenOff, setScreenOff] = useState(false);
  const [slow, setSlow] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<H264Player | null>(null);
  const sizeRef = useRef({ w: 720, h: 1600 });
  const down = useRef(false);
  const pendingMove = useRef<MirrorInput | null>(null);
  const raf = useRef(0);
  const setOpt = <K extends keyof MirrorOptions>(k: K, v: MirrorOptions[K]) => { const next = { ...opts, [k]: v }; setOpts(next); try { localStorage.setItem(KEY_OPTS, JSON.stringify(next)); } catch { /* storage unavailable */ } };

  const send = useCallback((i: MirrorInput) => { void api.mirrorInput(i); }, []);
  const tap = useCallback((keycode: number) => { send({ type: "key", action: ACTION.DOWN, keycode, meta: 0 }); send({ type: "key", action: ACTION.UP, keycode, meta: 0 }); }, [send]);

  const stop = useCallback(async () => {
    cancelAnimationFrame(raf.current);
    playerRef.current?.close();
    playerRef.current = null;
    setPhase("idle");
    setFps(0);
    await api.mirrorStop();
  }, []);

  const start = async () => {
    setError(null);
    setPhase("starting");
    try {
      const canvas = canvasRef.current!; // always mounted (hidden while idle), so no need to wait for a paint
      if (inTauri) {
        if (!H264Player.supported()) throw new Error("This version of macOS can't decode the phone's video in the app window.");
        const player = new H264Player(canvas);
        player.onSize = (w, h) => { sizeRef.current = { w, h }; setSize({ w, h }); };
        player.onError = (m) => { setError(m); void api.mirrorInput({ type: "resetVideo" }); };
        player.onFirstFrame = () => setPhase("live");
        playerRef.current = player;
        await api.mirrorStart(serial, opts, (b) => player.push(b));
      } else {
        await api.mirrorStart(serial, opts, () => {});
        canvas.width = 720; canvas.height = 1600; sizeRef.current = { w: 720, h: 1600 }; setSize({ w: 720, h: 1600 });
        const g = canvas.getContext("2d")!; const grad = g.createLinearGradient(0, 0, 720, 1600); grad.addColorStop(0, "#3b82f6"); grad.addColorStop(1, "#a855f7"); g.fillStyle = grad; g.fillRect(0, 0, 720, 1600);
        setPhase("live");
      }
      setScreenOff(opts.screenOff);
      canvas.focus();
    } catch (e) {
      playerRef.current?.close(); playerRef.current = null;
      setError(String(e instanceof Error ? e.message : e));
      setPhase("idle");
    }
  };

  // A black/off phone screen produces no frames: after a few seconds, say so and offer to wake it.
  useEffect(() => {
    setSlow(false);
    if (phase !== "starting") return;
    const t = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(t);
  }, [phase]);

  // fps counter
  useEffect(() => {
    if (phase !== "live") return;
    const t = setInterval(() => setFps(playerRef.current?.stats().fps ?? 0), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // The server ends on its own if the phone is unplugged or the encoder dies.
  useEffect(() => {
    const un = api.onMirrorEnded((reason) => { playerRef.current?.close(); playerRef.current = null; setPhase("idle"); if (reason) setError(reason); else toast("info", "Mirroring ended"); });
    const clip = api.onMirrorClipboard(() => toast("info", "Copied from your phone to the Mac clipboard", 1800));
    return () => { void un.then((f) => f()); void clip.then((f) => f()); };
  }, []);

  // Leaving the screen stops mirroring (and recording) so nothing keeps encoding in the background.
  useEffect(() => () => { void api.mirrorStop(); playerRef.current?.close(); cancelAnimationFrame(raf.current); }, []);
  useEffect(() => { if (!serial) void stop(); }, [serial, stop]);

  // ---- pointer ----
  const point = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { ...mapPoint(r, sizeRef.current.w, sizeRef.current.h, e.clientX, e.clientY), w: sizeRef.current.w, h: sizeRef.current.h };
  };
  const flushMove = () => { raf.current = 0; if (pendingMove.current) { send(pendingMove.current); pendingMove.current = null; } };
  const onPointerDown = (e: React.PointerEvent) => {
    canvasRef.current?.focus();
    if (e.button === 2) { send({ type: "backOrScreenOn", action: ACTION.DOWN }); send({ type: "backOrScreenOn", action: ACTION.UP }); return; }
    if (e.button === 1) { e.preventDefault(); tap(KEY.HOME); return; }
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    down.current = true;
    send({ type: "touch", action: ACTION.DOWN, pressure: 1, ...point(e) });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!down.current) return;
    pendingMove.current = { type: "touch", action: ACTION.MOVE, pressure: 1, ...point(e) };
    if (!raf.current) raf.current = requestAnimationFrame(flushMove);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!down.current) return;
    down.current = false;
    if (pendingMove.current) { send(pendingMove.current); pendingMove.current = null; }
    send({ type: "touch", action: ACTION.UP, pressure: 0, ...point(e) });
  };
  const onWheel = (e: React.WheelEvent) => send({ type: "scroll", hscroll: Math.max(-1, Math.min(1, -e.deltaX / 40)), vscroll: Math.max(-1, Math.min(1, -e.deltaY / 40)), ...point(e) });

  // ---- keyboard ----
  const shortcut = (name: string) => {
    if (name === "home") tap(KEY.HOME);
    else if (name === "back") { send({ type: "backOrScreenOn", action: ACTION.DOWN }); send({ type: "backOrScreenOn", action: ACTION.UP }); }
    else if (name === "recents") tap(KEY.APP_SWITCH);
    else if (name === "power") tap(KEY.POWER);
    else if (name === "volUp") tap(KEY.VOLUME_UP);
    else if (name === "volDown") tap(KEY.VOLUME_DOWN);
    else if (name === "rotate") send({ type: "rotate" });
    else if (name === "notifications") send({ type: "panel", kind: "notifications" });
    else if (name === "settings") send({ type: "panel", kind: "settings" });
    else if (name === "screenOff") toggleScreen();
  };
  const toggleScreen = () => {
    if (screenOff) { send({ type: "backOrScreenOn", action: ACTION.DOWN }); send({ type: "backOrScreenOn", action: ACTION.UP }); setScreenOff(false); }
    else { send({ type: "displayPower", on: false }); setScreenOff(true); }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const plan = planKey({ key: e.key, code: e.code, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey });
    if (!plan) return;
    e.preventDefault();
    if (plan.kind === "shortcut") return shortcut(plan.name);
    if (plan.kind === "text") return send({ type: "text", text: plan.text });
    send({ type: "key", action: ACTION.DOWN, keycode: plan.keycode, meta: e.shiftKey ? 1 : 0 });
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    const plan = planKey({ key: e.key, code: e.code, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey });
    if (plan?.kind === "key") send({ type: "key", action: ACTION.UP, keycode: plan.keycode, meta: 0 });
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text/plain");
    if (text) { e.preventDefault(); send({ type: "setClipboard", text, paste: true }); }
  };

  // ---- capture ----
  const screenshot = async () => {
    try {
      const dir = `${await home()}/Pictures/Droid Shuttle Screenshots`;
      const path = await api.phoneScreenshot(serial, dir);
      useUi.getState().toast({ kind: "ok", text: "Screenshot saved", action: { label: "Show in Finder", run: () => void api.revealInFinder(path) } }, 7000);
    } catch (e) { toast("error", String(e), 8000); }
  };
  const stopRecording = useCallback(async () => {
    setRecording(null);
    try {
      const path = await api.recordStop(`${await home()}/Movies/Droid Shuttle`);
      useUi.getState().toast({ kind: "ok", text: "Recording saved", action: { label: "Show in Finder", run: () => void api.revealInFinder(path) } }, 9000);
    } catch (e) { toast("error", String(e), 8000); }
  }, []);
  const toggleRecording = async () => {
    if (recording !== null) return void stopRecording();
    try { await api.recordStart(currentSerial() ?? serial, opts.bitRateMbps || 8); setRecording(0); } catch (e) { toast("error", String(e), 8000); }
  };
  useEffect(() => {
    if (recording === null) return;
    const t = setInterval(() => setRecording((s) => (s === null ? s : s + 1)), 1000);
    return () => clearInterval(t);
  }, [recording === null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (recording !== null && recording >= 178) { toast("info", "Android limits a single recording to 3 minutes — saving it now."); void stopRecording(); } }, [recording, stopRecording]);

  const togglePin = async () => { const v = !onTop; setOnTop(v); if (inTauri) await getCurrentWindow().setAlwaysOnTop(v); };
  const toggleFull = async () => { const v = !full; setFull(v); if (inTauri) await getCurrentWindow().setFullscreen(v); };

  const live = phase === "live";
  const aspect = size.w && size.h ? `${size.w} / ${size.h}` : "9 / 20";
  return (
    <div className="flex h-full min-h-0">
      {/* side toolbar */}
      {phase === "live" && (
        <div role="toolbar" aria-label="Phone controls" className="flex w-14 shrink-0 flex-col items-center gap-0.5 border-r py-3" style={{ borderColor: "var(--border)" }}>
          <Tool label="Home (⌥H)" onClick={() => tap(KEY.HOME)}><Home size={17} /></Tool>
          <Tool label="Back (⌥B, right-click)" onClick={() => shortcut("back")}><ArrowLeft size={17} /></Tool>
          <Tool label="Recent apps (⌥S)" onClick={() => tap(KEY.APP_SWITCH)}><SquareStack size={17} /></Tool>
          <Sep />
          <Tool label="Volume up (⌥↑)" onClick={() => tap(KEY.VOLUME_UP)}><Volume2 size={17} /></Tool>
          <Tool label="Volume down (⌥↓)" onClick={() => tap(KEY.VOLUME_DOWN)}><Volume1 size={17} /></Tool>
          <Tool label="Power (⌥P)" onClick={() => tap(KEY.POWER)}><Power size={17} /></Tool>
          <Sep />
          <Tool label="Notifications (⌥N)" onClick={() => send({ type: "panel", kind: "notifications" })}><Bell size={17} /></Tool>
          <Tool label="Rotate (⌥R)" onClick={() => send({ type: "rotate" })}><RotateCw size={17} /></Tool>
          <Tool label={screenOff ? "Turn phone screen on" : "Turn phone screen off (⌥O)"} on={screenOff} onClick={toggleScreen}><Sun size={17} /></Tool>
          <Sep />
          <Tool label="Screenshot" onClick={() => void screenshot()}><Camera size={17} /></Tool>
          <Tool label={recording !== null ? "Stop recording" : "Record screen"} on={recording !== null} danger={recording !== null} onClick={() => void toggleRecording()}>{recording !== null ? <Square size={15} fill="currentColor" /> : <Circle size={16} />}</Tool>
          {recording !== null && <span className="text-[10px] tabular-nums text-[var(--color-danger)]" aria-label="Recording time">{Math.floor(recording / 60)}:{String(recording % 60).padStart(2, "0")}</span>}
          <div className="mt-auto flex flex-col items-center gap-0.5">
            <Tool label={onTop ? "Stop keeping window on top" : "Keep window on top"} on={onTop} onClick={() => void togglePin()}><Pin size={16} /></Tool>
            <Tool label={full ? "Exit full screen" : "Full screen"} onClick={() => void toggleFull()}>{full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</Tool>
            <Tool label="Stop mirroring" danger onClick={() => void stop()}><X size={17} /></Tool>
          </div>
        </div>
      )}

      <div className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden p-4">
        {/* the live screen; kept mounted so decoding can start before the first frame */}
        <div className={clsx("relative h-full max-h-full", phase === "idle" && "hidden")} style={{ aspectRatio: aspect }}>
          <canvas
            ref={canvasRef}
            tabIndex={0}
            role="application"
            aria-label={`${deviceName} screen`}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
            onContextMenu={(e) => e.preventDefault()}
            onWheel={onWheel} onKeyDown={onKeyDown} onKeyUp={onKeyUp} onPaste={onPaste}
            className="size-full touch-none rounded-[22px] bg-black shadow-2xl outline-none ring-1 ring-black/20"
            style={{ cursor: "default" }}
          />
          {phase === "starting" && (
            <div className="absolute inset-0 grid place-items-center rounded-[22px] bg-black/70 p-6 text-center text-white">
              <div className="flex flex-col items-center gap-3">
                <span className="flex items-center gap-2"><Loader2 className="animate-spin" size={16} /> Connecting to {deviceName}…</span>
                {slow && <p className="max-w-56 text-[12px] text-white/70">Still waiting for the phone's screen. If it's off or locked, wake it up.</p>}
                <div className="flex gap-2">
                  {slow && <button onClick={() => { send({ type: "backOrScreenOn", action: ACTION.DOWN }); send({ type: "backOrScreenOn", action: ACTION.UP }); }} className="rounded-md bg-white/20 px-3 py-1 text-[12px] hover:bg-white/30">Wake phone</button>}
                  <button onClick={() => void stop()} className="rounded-md bg-white/10 px-3 py-1 text-[12px] hover:bg-white/20">Cancel</button>
                </div>
              </div>
            </div>
          )}
          {live && showStats && <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-2 py-1 font-mono text-[11px] text-white">{size.w}×{size.h} · {fps} fps</div>}
          {live && <button onClick={() => setShowStats((v) => !v)} aria-label="Toggle stats" className="absolute bottom-2 right-2 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-white/70 hover:text-white">{fps} fps</button>}
        </div>

        {phase === "idle" && (
          <div className="mx-auto flex w-full max-w-md flex-col gap-4">
            <div className="text-center">
              <span className="mx-auto mb-3 grid size-16 place-items-center rounded-2xl" style={{ background: "var(--selected)", color: "var(--color-accent)" }}><MonitorSmartphone size={30} /></span>
              <h1 className="text-[20px] font-semibold">Mirror {deviceName}</h1>
              <p className="text-[13px]" style={{ color: "var(--fg-muted)" }}>See your phone on the Mac and control it with the mouse and keyboard. Wake and unlock the phone first.</p>
            </div>
            {error && <div role="alert" className="flex items-start gap-2 rounded-lg border p-3 text-[12px]" style={{ borderColor: "var(--color-danger)" }}><AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--color-danger)]" /><span className="select-text">{error}</span></div>}
            <div className="rounded-xl border p-3" style={{ borderColor: "var(--border)" }}>
              <div className="mb-2 text-[12px] font-medium " style={{ color: "var(--fg-muted)" }}>Quality</div>
              <div role="radiogroup" aria-label="Resolution" className="mb-3 grid grid-cols-4 gap-1.5">
                {RESOLUTIONS.map(([v, label]) => <button key={label} role="radio" aria-checked={opts.maxSize === v} onClick={() => setOpt("maxSize", v)} className="rounded-md border py-1 text-[12px]" style={{ borderColor: opts.maxSize === v ? "var(--color-accent)" : "var(--border)", background: opts.maxSize === v ? "var(--selected)" : undefined }}>{label}</button>)}
              </div>
              <div className="grid grid-cols-2 gap-3 text-[12px]">
                <label className="flex flex-col gap-1">Bit rate
                  <select value={opts.bitRateMbps} onChange={(e) => setOpt("bitRateMbps", Number(e.target.value))} className="rounded-md border bg-transparent px-2 py-1" style={{ borderColor: "var(--border)" }}>{[4, 8, 16, 32].map((m) => <option key={m} value={m}>{m} Mbit/s</option>)}</select></label>
                <label className="flex flex-col gap-1">Frame rate
                  <select value={opts.maxFps} onChange={(e) => setOpt("maxFps", Number(e.target.value))} className="rounded-md border bg-transparent px-2 py-1" style={{ borderColor: "var(--border)" }}><option value={0}>Automatic</option><option value={60}>Up to 60 fps</option><option value={30}>Up to 30 fps</option></select></label>
              </div>
            </div>
            <div className="flex flex-col gap-2 rounded-xl border p-3 text-[13px]" style={{ borderColor: "var(--border)" }}>
              <label className="flex cursor-default items-center gap-2"><input type="checkbox" checked={opts.screenOff} onChange={(e) => setOpt("screenOff", e.target.checked)} /> Turn the phone's screen off while mirroring</label>
              <label className="flex cursor-default items-center gap-2"><input type="checkbox" checked={opts.showTouches} onChange={(e) => setOpt("showTouches", e.target.checked)} /> Show touches on the phone</label>
              <label className="flex cursor-default items-center gap-2"><input type="checkbox" checked={opts.stayAwake} onChange={(e) => setOpt("stayAwake", e.target.checked)} /> Keep the phone awake while charging</label>
            </div>
            <button onClick={() => void start()} className="rounded-lg bg-[var(--color-accent)] py-2.5 text-[14px] font-semibold text-[var(--accent-ink)]">Start mirroring</button>
            <p className="text-center text-[11px]" style={{ color: "var(--fg-muted)" }}>Click = tap · Right-click = Back · Middle-click = Home · Scroll wheel scrolls · Type to enter text · ⌘V pastes Mac text · ⌥H/⌥B/⌥S = Home/Back/Recents. Banking and other secure apps appear black — Android blocks capturing them.</p>
          </div>
        )}
      </div>
    </div>
  );
}
