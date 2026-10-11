import { useEffect, useRef, useState } from "react";
import { Loader2, Video } from "lucide-react";
import { api, inTauri } from "../../lib/api";
import { H264Player } from "../../lib/mirror";
import { useWebcam } from "../../store/webcam";
import { liveSummary } from "./helpers";

/**
 * Live preview of what OBS receives. It only exists while this screen is open: leaving it detaches the
 * preview, but the camera session keeps running (the call app is still using it).
 */
export function PreviewPane() {
  const info = useWebcam((s) => s.info);
  const options = useWebcam((s) => s.options);
  const running = info !== null;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setHasFrame(false);
    setNote(null);
    if (!running) return;
    const canvas = canvasRef.current!;
    if (!inTauri) {
      // Browser/Playwright: no video arrives, so paint a stand-in frame.
      canvas.width = 1280; canvas.height = 720;
      const g = canvas.getContext("2d")!;
      const grad = g.createLinearGradient(0, 0, 1280, 720);
      grad.addColorStop(0, "#3b82f6"); grad.addColorStop(1, "#a855f7");
      g.fillStyle = grad; g.fillRect(0, 0, 1280, 720);
      setHasFrame(true);
      void api.webcamAttachPreview(() => {});
      return () => { void api.webcamDetachPreview(); };
    }
    if (!H264Player.supported()) { setNote("This version of macOS can't show the preview in the app window."); return; }
    const player = new H264Player(canvas);
    player.onFirstFrame = () => setHasFrame(true);
    player.onError = (m) => setNote(m);
    api.webcamAttachPreview((b) => player.push(b)).catch((e) => setNote(String(e instanceof Error ? e.message : e)));
    return () => { player.close(); void api.webcamDetachPreview().catch(() => {}); };
  }, [running]);

  return (
    <div className="relative h-[clamp(200px,34vh,400px)] overflow-hidden rounded-xl bg-black ring-1 ring-black/20" role="group" aria-label="Camera preview">
      <canvas ref={canvasRef} className="size-full object-contain" style={{ visibility: hasFrame ? "visible" : "hidden" }} />
      {!hasFrame && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-[12.5px] text-white/70">
          {note ? (
            <p className="max-w-64">Preview unavailable: {note} The stream to OBS isn't affected.</p>
          ) : running ? (
            <span className="flex items-center gap-2"><Loader2 className="animate-spin" size={15} /> Waiting for the first frame…</span>
          ) : (
            <span className="flex flex-col items-center gap-2"><Video size={26} strokeWidth={1.5} /> Your phone's camera appears here once the webcam is on.</span>
          )}
        </div>
      )}
      {running && hasFrame && info && (
        <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white">
          <span className="size-2 rounded-full bg-[var(--color-danger)] motion-safe:animate-pulse" /> Live · {liveSummary(options, info.micActive)}
        </div>
      )}
    </div>
  );
}
