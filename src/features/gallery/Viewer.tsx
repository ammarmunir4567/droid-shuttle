import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronLeft, ChevronRight, Copy, Download, FolderOpen, Info, Loader2, MapPin, X } from "lucide-react";
import { api, formatBytes, inTauri, toSrc, type MediaItem } from "../../lib/api";
import { stageToClipboard } from "../../lib/clipboard";
import { baseName, parentPath } from "../../lib/paths";
import { useFiles } from "../../store/files";
import { useGallery } from "../../store/gallery";
import { useNav } from "../../store/nav";
import { useUi } from "../../store/ui";
import { fullDate } from "./lib";
import { thumbKey } from "./Thumb";

const openKey = (serial: string, path: string) => ["open", serial, path];

export function Viewer({ items, serial }: { items: MediaItem[]; serial: string }) {
  const { viewer, set } = useGallery();
  const qc = useQueryClient();
  const idx = items.findIndex((i) => i.path === viewer);
  const item = items[idx];
  const [showInfo, setShowInfo] = useState(false);
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const opened = useQuery({ queryKey: openKey(serial, item?.path ?? ""), queryFn: () => api.mediaOpen(serial, item!), enabled: !!item, retry: false, staleTime: Infinity, gcTime: 2 * 60_000 });
  const placeholder = qc.getQueryData<string>(thumbKey(serial, item?.path ?? "", "full"));
  const info = useQuery({ queryKey: ["mediaInfo", serial, item?.path], queryFn: () => api.mediaInfo(serial, item!.path), enabled: !!item && showInfo && item.kind === "image", retry: false, staleTime: Infinity });
  const transfer = useUi((s) => Object.values(s.transfers).find((t) => item && t.finishedMs === null && t.label === baseName(item.path)));

  const go = (d: number) => {
    const n = items[idx + d];
    if (n) { set({ viewer: n.path, selection: [n.path], anchor: n.path }); setZoom({ s: 1, x: 0, y: 0 }); }
  };
  const close = () => set({ viewer: null });

  // Quietly fetch the neighbours so ←/→ feels instant.
  useEffect(() => {
    if (!item) return;
    const t = setTimeout(() => {
      for (const n of [items[idx + 1], items[idx - 1]]) if (n && n.kind === "image" && n.size < 25_000_000) void qc.prefetchQuery({ queryKey: openKey(serial, n.path), queryFn: () => api.mediaOpen(serial, n), staleTime: Infinity });
    }, 400);
    return () => clearTimeout(t);
  }, [idx, items, serial, qc, item]);

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key.toLowerCase() === "i") setShowInfo((v) => !v);
      else if (e.key === "0") setZoom({ s: 1, x: 0, y: 0 });
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") { e.preventDefault(); void stageToClipboard([{ path: item.path, isDir: false }]); }
      else return;
      if (e.key.startsWith("Arrow") || e.key === "Escape") e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const maps = useMemo(() => (info.data?.latitude != null && info.data?.longitude != null ? `https://maps.apple.com/?ll=${info.data.latitude},${info.data.longitude}&q=Photo` : null), [info.data]);
  if (!item) return null;
  const src = opened.data ? toSrc(opened.data) : null;

  return (
    <div role="dialog" aria-modal="true" aria-label={baseName(item.path)} className="fixed inset-0 z-50 flex bg-black text-white">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 pb-6 pt-3">
          <button aria-label="Close" onClick={close} className="grid size-8 place-items-center rounded-full hover:bg-white/15"><X size={18} /></button>
          <div className="min-w-0">
            <div className="truncate font-medium">{baseName(item.path)}</div>
            <div className="text-[12px] text-white/60">{fullDate(item.dateMs)} · {item.bucket} · {idx + 1} of {items.length}</div>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button aria-label="Import this item" title="Import this item" onClick={() => { set({ selection: [item.path], importOpen: true }); }} className="grid size-8 place-items-center rounded-full hover:bg-white/15"><Download size={17} /></button>
            <button aria-label="Copy to clipboard" title="Copy (⌘C), then paste in Finder" onClick={() => void stageToClipboard([{ path: item.path, isDir: false }])} className="grid size-8 place-items-center rounded-full hover:bg-white/15"><Copy size={16} /></button>
            <button aria-label="Show in Files" title="Show in Files" onClick={() => { useFiles.getState().navigate("device", parentPath(item.path)); useFiles.getState().select("device", [item.path], item.path); useNav.getState().setSection("files"); close(); }} className="grid size-8 place-items-center rounded-full hover:bg-white/15"><FolderOpen size={17} /></button>
            <button aria-label="Info" aria-pressed={showInfo} title="Info (i)" onClick={() => setShowInfo((v) => !v)} className={`grid size-8 place-items-center rounded-full hover:bg-white/15 ${showInfo ? "bg-white/20" : ""}`}><Info size={17} /></button>
          </div>
        </div>

        {idx > 0 && <button aria-label="Previous" onClick={() => go(-1)} className="absolute left-3 top-1/2 z-10 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/40 hover:bg-black/70"><ChevronLeft /></button>}
        {idx < items.length - 1 && <button aria-label="Next" onClick={() => go(1)} className="absolute right-3 top-1/2 z-10 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/40 hover:bg-black/70"><ChevronRight /></button>}

        <div
          className="relative min-h-0 flex-1 overflow-hidden"
          onWheel={(e) => { if (item.kind === "image") setZoom((z) => { const s = Math.min(8, Math.max(1, z.s * Math.exp(-e.deltaY / 300))); return s === 1 ? { s, x: 0, y: 0 } : { ...z, s }; }); }}
          onPointerDown={(e) => { if (zoom.s > 1) { drag.current = { x: e.clientX, y: e.clientY, ox: zoom.x, oy: zoom.y }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } }}
          onPointerMove={(e) => { const d = drag.current; if (d) setZoom((z) => ({ ...z, x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y })); }}
          onPointerUp={() => { drag.current = null; }}
          onDoubleClick={() => item.kind === "image" && setZoom((z) => (z.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 }))}
        >
          {item.kind === "video" && src ? (
            <video key={src} src={src} controls autoPlay className="absolute inset-0 size-full object-contain" />
          ) : src ? (
            <img key={src} src={src} alt={baseName(item.path)} draggable={false} className="absolute inset-0 size-full select-none object-contain" style={{ imageOrientation: "from-image", transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`, cursor: zoom.s > 1 ? "grab" : "zoom-in" }} />
          ) : opened.isError ? (
            <div className="absolute inset-0 grid place-items-center text-center text-white/70"><div><p className="font-medium text-white">Can't open this file</p><p className="text-[12px]">{String(opened.error)}</p></div></div>
          ) : (
            <div className="absolute inset-0 grid place-items-center">
              {placeholder && <img src={toSrc(placeholder)} alt="" className="absolute inset-0 size-full object-contain opacity-60 blur-sm" />}
              <div className="relative flex flex-col items-center gap-2 rounded-xl bg-black/60 px-5 py-3 text-[12px]">
                <Loader2 className="animate-spin" />
                {item.kind === "video" ? `Copying video from phone… ${transfer && transfer.bytesTotal ? Math.round((transfer.bytesDone / transfer.bytesTotal) * 100) + "%" : ""}` : "Loading…"}
              </div>
            </div>
          )}
        </div>
      </div>

      {showInfo && (
        <aside aria-label="Details" className="w-[300px] shrink-0 overflow-auto border-l border-white/10 bg-[#1b1b1d] p-4 text-[13px]">
          <h3 className="mb-3 text-[12px] font-semibold  text-white/50">Details</h3>
          <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2">
            <Row k="Name" v={baseName(item.path)} />
            <Row k="Date" v={fullDate(item.dateMs)} />
            <Row k="Size" v={formatBytes(item.size)} />
            {item.width > 0 && <Row k="Dimensions" v={`${item.width} × ${item.height}${item.width * item.height > 1e6 ? ` (${(item.width * item.height / 1e6).toFixed(1)} MP)` : ""}`} />}
            <Row k="Album" v={item.bucket} />
            <Row k="Type" v={item.mime} />
            {info.data?.camera && <Row k="Camera" v={info.data.camera} />}
            {info.data?.lens && <Row k="Lens" v={info.data.lens} />}
            {info.data?.exposure && <Row k="Exposure" v={[info.data.exposure, info.data.aperture, info.data.iso && `ISO ${info.data.iso}`, info.data.focalLength].filter(Boolean).join(" · ")} />}
            {info.data?.software && <Row k="Software" v={info.data.software} />}
            <Row k="Path" v={item.path} mono />
          </dl>
          {maps && <button onClick={() => (inTauri ? void openUrl(maps) : window.open(maps))} className="mt-4 flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 hover:bg-white/15"><MapPin size={14} /> Show location in Maps</button>}
          {info.isLoading && <p className="mt-3 text-white/50">Reading metadata…</p>}
          {item.kind === "image" && info.isSuccess && !info.data.camera && !maps && <p className="mt-3 text-white/50">No camera metadata (messaging apps strip it).</p>}
        </aside>
      )}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-white/50">{k}</dt>
      <dd className={`select-text break-words ${mono ? "font-mono text-[11px]" : ""}`}>{v}</dd>
    </>
  );
}
