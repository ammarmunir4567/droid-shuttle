import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ImageOff, Play } from "lucide-react";
import { api, toSrc, type MediaItem } from "../../lib/api";
import { formatDuration } from "./lib";

/** Wait a beat after mounting so tiles scrolled past in a flick never hit the phone. */
function useSettled(ms = 120) {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setOk(true), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return ok;
}

export const thumbKey = (serial: string, path: string, tier: "fast" | "full") => ["thumb", serial, path, tier];

/** Square thumbnail: instant EXIF preview for big photos, upgraded to a proper thumbnail. */
export function Thumb({ item, serial }: { item: MediaItem; serial: string }) {
  const settled = useSettled();
  const wantsFast = item.kind === "image" && item.size > 1_200_000;
  const fast = useQuery({ queryKey: thumbKey(serial, item.path, "fast"), queryFn: () => api.mediaThumb(serial, item, true), enabled: settled && wantsFast, retry: false, staleTime: Infinity });
  const full = useQuery({ queryKey: thumbKey(serial, item.path, "full"), queryFn: () => api.mediaThumb(serial, item, false), enabled: settled, retry: false, staleTime: Infinity, gcTime: 10 * 60_000 });
  const [broken, setBroken] = useState(false);
  const src = broken ? undefined : (full.data ?? fast.data);
  return (
    <div className="relative size-full overflow-hidden" style={{ background: "var(--hover)" }}>
      {src ? (
        <img src={toSrc(src)} alt="" draggable={false} onError={() => setBroken(true)} className={full.data ? "size-full object-cover" : "size-full scale-105 object-cover blur-[1px]"} />
      ) : full.isError || broken ? (
        <div className="grid size-full place-items-center" style={{ color: "var(--fg-muted)" }}>{item.kind === "video" ? <Play size={22} /> : <ImageOff size={22} strokeWidth={1.4} />}</div>
      ) : (
        <div className="size-full animate-pulse" style={{ background: "var(--border)" }} />
      )}
      {item.kind === "video" && (
        <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
          <Play size={9} fill="currentColor" />{formatDuration(item.durationMs)}
        </span>
      )}
    </div>
  );
}
