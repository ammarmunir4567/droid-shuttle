import { useEffect } from "react";
import { AlertTriangle, Loader2, Video } from "lucide-react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { api } from "../../lib/api";
import { useDevices } from "../../store/devices";
import { useWebcam } from "../../store/webcam";
import {
  BIT_RATES, DEFAULT_PORT, FPS_CHOICES, MIC_SOURCES, RESOLUTION_PRESETS, ROTATIONS, autoDeviceLabel, cameraLabel, compatibilityNotes, formatDelay,
  outputWarning, selectedCamera, sizeListed, sortedDevices, withCamera, withFacing,
} from "./helpers";
import { PreviewPane } from "./PreviewPane";
import { SetupChecklist } from "./SetupChecklist";
import { UseInZoom } from "./UseInZoom";
import { Card, Meter, Seg, borderStyle, selectClass } from "./parts";

// Unlike Mirror, leaving this screen does NOT stop the camera: the session lives in the store and
// the backend, because a call app is using it. Only the preview attaches and detaches with the screen.
export function WebcamView() {
  const serial = useDevices((s) => s.selected)!;
  const deviceName = useDevices((s) => s.devices.find((d) => d.serial === s.selected)?.model ?? "your phone");
  // `level` is left out on purpose: it changes ten times a second and only the meter needs it.
  const { options, info, starting, error, prereqs, cameras, camerasFailed, devices, checking } = useWebcam(useShallow((s) => ({
    options: s.options, info: s.info, starting: s.starting, error: s.error, prereqs: s.prereqs, cameras: s.cameras, camerasFailed: s.camerasFailed, devices: s.devices, checking: s.checking,
  })));
  const { setOption, setOptions, start, stop, refresh, clearError } = useWebcam.getState();

  useEffect(() => { void refresh(serial); }, [serial, refresh]);

  const running = info !== null;
  const locked = running || starting;
  const note = compatibilityNotes(prereqs);
  const micOk = prereqs?.micSupported ?? true;
  const list = cameras ?? [];
  const cam = selectedCamera(options, list);
  const needsCamera = list.length > 0 && !cam; // remembered a camera this phone doesn't have
  const blocked = note.camera ? note.camera : needsCamera ? "Choose a camera first." : null;
  const micOn = options.mic && micOk;
  const warning = outputWarning(devices, options.outputDevice, micOn);
  const resolutionId = RESOLUTION_PRESETS.find((p) => p.width === options.width && p.height === options.height)?.id ?? "";

  return (
    <div className="@container h-full overflow-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-5">
        <div className="text-center">
          <span className="mx-auto mb-3 grid size-16 place-items-center rounded-2xl" style={{ background: "var(--selected)", color: "var(--color-accent)" }}><Video size={30} /></span>
          <h1 className="text-[20px] font-semibold">Use {deviceName} as a webcam</h1>
          <p className="mx-auto max-w-lg text-[13px]" style={{ color: "var(--fg-muted)" }}>Send your phone's camera and microphone to Zoom, Google Meet or any recording app. Keep the phone connected by USB.</p>
          <div className="mx-auto mt-4 flex w-full max-w-xs flex-col gap-1.5">
            {running ? (
              <button type="button" onClick={() => void stop()} className="flex items-center justify-center gap-2 rounded-lg border py-2.5 text-[14px] font-semibold" style={{ borderColor: "var(--color-danger)", color: "var(--color-danger)", background: "color-mix(in oklab, var(--color-danger) 12%, transparent)" }}>
                <span className="size-2.5 rounded-full bg-[var(--color-danger)] motion-safe:animate-pulse" aria-hidden /> Stop webcam
              </button>
            ) : (
              <button type="button" onClick={() => void start(serial)} disabled={starting || blocked !== null} title={blocked ?? undefined} className="flex items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] py-2.5 text-[14px] font-semibold text-[var(--accent-ink)] disabled:opacity-50">
                {starting && <Loader2 size={15} className="animate-spin" />}{starting ? "Starting…" : "Start webcam"}
              </button>
            )}
            {running && <p className="text-[11.5px]" style={{ color: "var(--fg-muted)" }}>Stop the webcam to change the camera and microphone settings (the mic delay can be changed live). It keeps running if you switch screens or close the window.</p>}
            {!running && !starting && needsCamera && <p className="text-[11.5px]" style={{ color: "var(--fg-muted)" }}>{blocked}</p>}
          </div>
        </div>

        {error && (
          <div role="alert" className="mx-auto flex w-full max-w-xl items-start gap-2 rounded-lg border p-3 text-[12px]" style={{ borderColor: "var(--color-danger)" }}>
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
            <span className="min-w-0 flex-1 select-text">{error}</span>
            <button type="button" onClick={clearError} className="shrink-0 text-[11px] underline" aria-label="Dismiss error">Dismiss</button>
          </div>
        )}

        <div className="grid gap-4 @3xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] @3xl:items-start">
          <div className="flex min-w-0 flex-col gap-4">
            <SetupChecklist prereqs={prereqs} checking={checking} onRecheck={() => void refresh(serial, true)} />

            <Card title="Camera">
              <fieldset disabled={locked} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0 text-[12px]">
                {list.length > 0 ? (
                  <select aria-label="Camera" value={cam?.id ?? ""} onChange={(e) => { const c = list.find((x) => x.id === e.target.value); if (c) setOptions(withCamera(options, c)); }} className={selectClass} style={borderStyle}>
                    {!cam && <option value="" disabled>Choose a camera…</option>}
                    {list.map((c) => <option key={c.id} value={c.id}>{cameraLabel(c, list)}</option>)}
                  </select>
                ) : cameras === null && checking ? (
                  <p className="flex items-center gap-2" style={{ color: "var(--fg-muted)" }}><Loader2 size={13} className="animate-spin" /> Looking for the phone's cameras…</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <Seg label="Camera" value={options.facing === "front" ? "front" : "back"} options={[{ value: "back", label: "Back" }, { value: "front", label: "Front" }]} onChange={(f) => setOptions(withFacing(options, f))} />
                    {camerasFailed && <p style={{ color: "var(--fg-muted)" }}>Couldn't list this phone's cameras, so choose a side instead.</p>}
                  </div>
                )}

                <div className="flex flex-col gap-1.5">
                  <span>Resolution</span>
                  <Seg label="Resolution" value={resolutionId} options={RESOLUTION_PRESETS.map((p) => ({ value: p.id as string, label: p.label }))} onChange={(id) => { const p = RESOLUTION_PRESETS.find((x) => x.id === id)!; setOptions({ ...options, width: p.width, height: p.height }); }} />
                  {cam && !sizeListed(cam, options.width, options.height) && <p style={{ color: "var(--fg-muted)" }}>This camera doesn't list {options.width}×{options.height}; it may fall back to another size.</p>}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <span>Frame rate</span>
                    <Seg label="Frame rate" value={options.fps} options={FPS_CHOICES.map((f) => ({ value: f as number, label: `${f} fps` }))} onChange={(v) => setOption("fps", v)} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span>Rotation</span>
                    <Seg label="Rotation" value={options.rotation} options={ROTATIONS.map((r) => ({ value: r as number, label: `${r}°` }))} onChange={(v) => setOption("rotation", v)} />
                  </div>
                </div>

                <details className="group">
                  <summary className="w-fit cursor-default select-none" style={{ color: "var(--fg-muted)" }}>Advanced</summary>
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1">Bit rate
                      <select value={options.bitRateMbps} onChange={(e) => setOption("bitRateMbps", Number(e.target.value))} className={selectClass} style={borderStyle}>{BIT_RATES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                    </label>
                    <label className="flex flex-col gap-1">OBS port
                      <input type="number" min={0} max={65535} inputMode="numeric" placeholder={`${DEFAULT_PORT} (automatic)`} value={options.port || ""} onChange={(e) => setOption("port", Number(e.target.value) || 0)} className={selectClass} style={borderStyle} />
                    </label>
                  </div>
                </details>
              </fieldset>
            </Card>

            <Card title="Microphone">
              <fieldset disabled={locked} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0 text-[12px]">
                <label className="flex cursor-default items-center gap-2 text-[13px]">
                  <input type="checkbox" checked={micOn} disabled={!micOk} onChange={(e) => setOption("mic", e.target.checked)} /> Send the phone's microphone too
                </label>
                {note.mic && <p style={{ color: "var(--fg-muted)" }}>{note.mic}</p>}
                {micOn && (
                  <>
                    <label className="flex flex-col gap-1">Microphone type
                      <select value={options.micSource} onChange={(e) => setOption("micSource", e.target.value as typeof options.micSource)} className={selectClass} style={borderStyle}>{MIC_SOURCES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
                    </label>
                    <label className="flex flex-col gap-1">Play it to
                      <select value={options.outputDevice} onChange={(e) => setOption("outputDevice", e.target.value)} className={selectClass} style={borderStyle}>
                        <option value="">{autoDeviceLabel(devices)}</option>
                        {sortedDevices(devices).map((d) => <option key={d.name} value={d.name}>{d.name}{d.supports48k ? "" : " (no 48 kHz)"}</option>)}
                      </select>
                    </label>
                    {warning && <p role="note" className="flex items-start gap-1.5 rounded-lg border p-2" style={{ borderColor: "var(--color-warn)" }}><AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--color-warn)]" />{warning}</p>}
                  </>
                )}
              </fieldset>
              {micOn && (
                // Outside the locked fieldset: lip-sync is tuned while watching yourself in OBS, so it works live.
                <label className="mt-3 flex flex-col gap-1 text-[12px]">
                  <span className="flex items-center justify-between">Mic delay <span className="tabular-nums" style={{ color: "var(--fg-muted)" }}>{formatDelay(options.audioDelayMs)}</span></span>
                  <input type="range" aria-label="Mic delay" min={0} max={1000} step={10} value={options.audioDelayMs} disabled={starting}
                    onChange={(e) => { const ms = Number(e.target.value); setOption("audioDelayMs", ms); if (running) void api.webcamSetDelay(ms).catch(() => {}); }} style={{ accentColor: "var(--color-accent)" }} />
                  <span style={{ color: "var(--fg-muted)" }}>OBS adds a little delay to the picture. Delay the voice by the same amount to keep lips and sound together{running ? ", and adjust it while you watch yourself in OBS" : ""}.</span>
                </label>
              )}
              {running && micOn && (
                <div className="mt-3 flex flex-col gap-1 text-[12px]">
                  <span style={{ color: "var(--fg-muted)" }}>Level{info?.outputDevice ? ` · playing to ${info.outputDevice}` : ""}</span>
                  <Meter />
                  {info?.micNote && <p className="mt-1 flex items-start gap-1.5"><AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--color-warn)]" />{info.micNote}</p>}
                </div>
              )}
            </Card>

          </div>

          <div className={clsx("flex min-w-0 flex-col gap-4 @3xl:sticky @3xl:top-0", running && "order-first @3xl:order-none")}>
            <PreviewPane />
            <UseInZoom />
          </div>
        </div>
      </div>
    </div>
  );
}
