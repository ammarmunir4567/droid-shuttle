import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Camera, Check, Download, Film, FolderClosed, Image as ImageIcon, Images, Loader2, RefreshCw, Sparkles, X, Smartphone } from "lucide-react";
import { api, formatBytes } from "../../lib/api";
import { stageToClipboard } from "../../lib/clipboard";
import { plural } from "../../lib/paths";
import { useDevices } from "../../store/devices";
import { useGallery, type MediaFilter } from "../../store/gallery";
import { useUi } from "../../store/ui";
import { ImportDialog } from "./ImportDialog";
import { MediaGrid } from "./MediaGrid";
import { Viewer } from "./Viewer";
import { applyFilters, isScreenshot } from "./lib";

const FILTERS: { id: MediaFilter; label: string; icon: typeof Images }[] = [
  { id: "all", label: "All", icon: Images },
  { id: "photos", label: "Photos", icon: ImageIcon },
  { id: "videos", label: "Videos", icon: Film },
  { id: "screenshots", label: "Screenshots", icon: Smartphone },
];

export function GalleryView() {
  const serial = useDevices((s) => s.selected)!;
  const qc = useQueryClient();
  const g = useGallery();
  const { filter, album, onlyNew, grouping, tile, selection, set, persist } = g;

  const { data: all = [], isLoading } = useQuery({ queryKey: ["media", serial], queryFn: () => api.mediaList(serial), staleTime: Infinity });
  const scan = useMutation({
    mutationFn: () => api.mediaScan(serial),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["media", serial] }),
    onError: (e) => useUi.getState().toast({ kind: "error", text: `Couldn't read the photo library: ${String(e)}` }, 7000),
  });
  // Show the cached index instantly, then refresh from the phone in the background.
  useEffect(() => { scan.mutate(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [serial]);
  useEffect(() => {
    const un = api.onMediaChanged(() => {
      void qc.invalidateQueries({ queryKey: ["media", serial] });
      const dest = useGallery.getState().lastImportDest;
      if (dest) useUi.getState().toast({ kind: "ok", text: "Import finished", action: { label: "Show in Finder", run: () => void api.revealInFinder(dest) } }, 8000);
    });
    return () => { void un.then((f) => f()); };
  }, [qc, serial]);

  const items = useMemo(() => applyFilters(all, { filter, album, onlyNew }), [all, filter, album, onlyNew]);
  const albums = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of all) m.set(i.bucket || "Other", (m.get(i.bucket || "Other") ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [all]);
  const counts = useMemo(() => ({
    all: all.length, photos: all.filter((i) => i.kind === "image" && !isScreenshot(i)).length,
    videos: all.filter((i) => i.kind === "video").length, screenshots: all.filter(isScreenshot).length,
  }), [all]);
  const newCount = useMemo(() => items.filter((i) => !i.imported).length, [items]);

  const selSet = useMemo(() => new Set(selection), [selection]);
  const selected = useMemo(() => all.filter((i) => selSet.has(i.path)), [all, selSet]);
  const importItems = selected.length ? selected : items.filter((i) => !i.imported);
  const viewerItems = items; // ←/→ in the viewer follows what's on screen

  return (
    <div className="flex h-full min-h-0">
      <aside aria-label="Library" className="w-52 shrink-0 overflow-auto border-r px-2 pb-3 pt-2" style={{ borderColor: "var(--border)" }}>
        <div className="px-2 pb-1 pt-1 text-[12px] font-medium " style={{ color: "var(--fg-muted)" }}>Library</div>
        {FILTERS.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => set({ filter: id, selection: [] })} aria-current={filter === id} className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-[var(--hover)]", filter === id && "bg-[var(--selected)] font-medium")}>
            <Icon size={15} className="text-[var(--color-accent)]" /><span className="flex-1">{label}</span><span className="text-[11px]" style={{ color: "var(--fg-muted)" }}>{counts[id]}</span>
          </button>
        ))}
        <div className="px-2 pb-1 pt-4 text-[12px] font-medium " style={{ color: "var(--fg-muted)" }}>Albums</div>
        <button onClick={() => set({ album: null, selection: [] })} className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-[var(--hover)]", album === null && "bg-[var(--selected)] font-medium")}><Camera size={15} className="text-[var(--color-accent)]" /><span className="flex-1">All albums</span></button>
        {albums.map(([name, n]) => (
          <button key={name} onClick={() => set({ album: name, selection: [] })} className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-[var(--hover)]", album === name && "bg-[var(--selected)] font-medium")}>
            <FolderClosed size={15} className="shrink-0 text-[var(--color-accent)]" /><span className="min-w-0 flex-1 truncate">{name}</span><span className="text-[11px]" style={{ color: "var(--fg-muted)" }}>{n}</span>
          </button>
        ))}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div data-tauri-drag-region className="flex h-11 shrink-0 items-center gap-3 border-b px-4" style={{ borderColor: "var(--border)" }}>
          {selected.length > 0 ? (
            <>
              <button aria-label="Clear selection" onClick={() => set({ selection: [], anchor: null })} className="grid size-6 place-items-center rounded-full hover:bg-[var(--hover)]"><X size={14} /></button>
              <span className="font-medium">{selected.length} selected</span>
              <span style={{ color: "var(--fg-muted)" }}>{formatBytes(selected.reduce((n, i) => n + i.size, 0))}</span>
              <button onClick={() => void stageToClipboard(selected.map((i) => ({ path: i.path, isDir: false })))} className="ml-2 rounded-md border px-2 py-1 text-[12px]" style={{ borderColor: "var(--border)" }}>Copy</button>
            </>
          ) : (
            <>
              <span className="text-[15px] font-semibold">{album ?? FILTERS.find((f) => f.id === filter)!.label}</span>
              <span style={{ color: "var(--fg-muted)" }}>{plural(items.length, "item")}</span>
              {scan.isPending && <span className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--fg-muted)" }}><Loader2 size={12} className="animate-spin" /> Syncing with phone…</span>}
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button aria-pressed={onlyNew} onClick={() => persist({ onlyNew: !onlyNew })} title="Hide items you've already imported" className={clsx("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]", onlyNew && "bg-[var(--selected)] text-[var(--color-accent)]")} style={{ borderColor: onlyNew ? "var(--color-accent)" : "var(--border)" }}>
              {onlyNew ? <Check size={12} /> : <Sparkles size={12} />} New only
            </button>
            <div role="radiogroup" aria-label="Group by" className="flex overflow-hidden rounded-md border text-[12px]" style={{ borderColor: "var(--border)" }}>
              {(["day", "month"] as const).map((gp) => <button key={gp} role="radio" aria-checked={grouping === gp} onClick={() => persist({ grouping: gp })} className={clsx("px-2 py-1 capitalize", grouping === gp && "bg-[var(--selected)] font-medium")}>{gp}</button>)}
            </div>
            <input type="range" aria-label="Thumbnail size" min={90} max={260} step={10} value={tile} onChange={(e) => persist({ tile: Number(e.target.value) })} className="w-24 accent-[var(--color-accent)]" />
            <button aria-label="Refresh from phone" title="Refresh from phone" onClick={() => scan.mutate()} disabled={scan.isPending} className="grid size-7 place-items-center rounded-md hover:bg-[var(--hover)] disabled:opacity-40"><RefreshCw size={14} className={scan.isPending ? "animate-spin" : ""} /></button>
            <button disabled={!importItems.length} onClick={() => set({ importOpen: true })} className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 font-medium text-[var(--accent-ink)] disabled:opacity-40">
              <Download size={14} />{selected.length ? `Import ${selected.length}` : newCount ? `Import ${newCount} new` : "Import"}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 pt-2">
          {isLoading || (all.length === 0 && scan.isPending) ? (
            <div className="grid h-full place-items-center" style={{ color: "var(--fg-muted)" }}><div className="flex items-center gap-2"><Loader2 className="animate-spin" size={16} /> Reading your photo library…</div></div>
          ) : items.length === 0 ? (
            <div className="grid h-full place-items-center text-center" style={{ color: "var(--fg-muted)" }}>
              <div><Images size={40} strokeWidth={1.2} className="mx-auto mb-2" /><p className="font-medium text-[var(--fg)]">{onlyNew && all.length ? "Everything here is already imported" : "No photos or videos found"}</p>
                <p className="text-[12px]">{onlyNew && all.length ? "Turn off “New only” to see them again." : "Try another album or filter."}</p></div>
            </div>
          ) : (
            <MediaGrid items={items} serial={serial} />
          )}
        </div>
      </div>

      <Viewer items={viewerItems} serial={serial} />
      <ImportDialog items={importItems} serial={serial} />
    </div>
  );
}
