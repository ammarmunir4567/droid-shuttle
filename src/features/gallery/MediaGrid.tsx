import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { Check, CheckCircle2 } from "lucide-react";
import { api, type MediaItem } from "../../lib/api";
import { stageToClipboard } from "../../lib/clipboard";
import { useGallery } from "../../store/gallery";
import { useVariant } from "../../theme/appearance";
import { buildRows } from "./lib";
import { Thumb } from "./Thumb";

const HEADER_H = 44;

interface TileProps { item: MediaItem; serial: string; size: number; selected: boolean; onSelect: (e: React.MouseEvent, i: MediaItem) => void; onToggle: (i: MediaItem) => void; onOpen: (i: MediaItem) => void; onDown: (e: React.PointerEvent, i: MediaItem) => void }

const Tile = memo(function Tile({ item, serial, size, selected, onSelect, onToggle, onOpen, onDown }: TileProps) {
  return (
    <div
      role="gridcell"
      aria-selected={selected}
      aria-label={item.path.split("/").pop()}
      data-path={item.path}
      onPointerDown={(e) => onDown(e, item)}
      onClick={(e) => onSelect(e, item)}
      onDoubleClick={() => onOpen(item)}
      className={clsx("group relative shrink-0 cursor-default overflow-hidden rounded-md", selected && "ring-[3px] ring-[var(--color-accent)]")}
      style={{ width: size, height: size }}
    >
      <Thumb item={item} serial={serial} />
      <button
        aria-label={selected ? "Deselect" : "Select"}
        onClick={(e) => { e.stopPropagation(); onToggle(item); }}
        onDoubleClick={(e) => e.stopPropagation()}
        className={clsx("absolute left-1.5 top-1.5 grid size-5 place-items-center rounded-full border-2 border-white text-white shadow transition-opacity", selected ? "bg-[var(--color-accent)] opacity-100" : "bg-black/30 opacity-0 group-hover:opacity-100")}
      >
        {selected && <Check size={12} strokeWidth={3} />}
      </button>
      {item.imported && <CheckCircle2 size={15} className="absolute bottom-1 right-1 rounded-full bg-black/50 text-[var(--color-ok)]" aria-label="Already imported" />}
    </div>
  );
});

export function MediaGrid({ items, serial }: { items: MediaItem[]; serial: string }) {
  const { tile, grouping, selection, set } = useGallery();
  const GAP = useVariant().gridGap;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Fill the row exactly: pick the column count for the requested tile size, then stretch tiles to fit.
  const cols = Math.max(1, Math.floor((width - 24 + GAP) / (tile + GAP)));
  const size = Math.floor((width - 24 - GAP * (cols - 1)) / cols);
  const { rows } = useMemo(() => buildRows(items, grouping, cols), [items, grouping, cols]);
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: (i) => (rows[i].type === "header" ? HEADER_H : size + GAP), overscan: 6 });
  useEffect(() => virt.measure(), [size, rows, virt]);

  const selSet = useMemo(() => new Set(selection), [selection]);
  const order = useMemo(() => items.map((i) => i.path), [items]);

  const onSelect = useCallback((e: React.MouseEvent, item: MediaItem) => {
    const g = useGallery.getState();
    if (e.shiftKey && g.anchor) {
      const a = order.indexOf(g.anchor), b = order.indexOf(item.path);
      if (a >= 0 && b >= 0) return set({ selection: order.slice(Math.min(a, b), Math.max(a, b) + 1) });
    }
    if (e.metaKey || e.ctrlKey) return set({ selection: g.selection.includes(item.path) ? g.selection.filter((p) => p !== item.path) : [...g.selection, item.path], anchor: item.path });
    set({ selection: [item.path], anchor: item.path });
  }, [order, set]);
  const onToggle = useCallback((item: MediaItem) => {
    const g = useGallery.getState();
    set({ selection: g.selection.includes(item.path) ? g.selection.filter((p) => p !== item.path) : [...g.selection, item.path], anchor: item.path });
  }, [set]);
  const onOpen = useCallback((item: MediaItem) => set({ viewer: item.path }), [set]);

  // Dragging selected photos out of the window hands the drag to macOS (promised files → Finder, Mail, …).
  const onDown = useCallback((e: React.PointerEvent, item: MediaItem) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const [sx, sy] = [e.clientX, e.clientY];
    const cleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", cleanup); };
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      if (ev.clientX < 0 || ev.clientY < 0 || ev.clientX > window.innerWidth || ev.clientY > window.innerHeight) {
        cleanup();
        const g = useGallery.getState();
        const paths = g.selection.includes(item.path) ? g.selection : [item.path];
        if (!g.selection.includes(item.path)) set({ selection: [item.path], anchor: item.path });
        void api.nativeDrag(serial, paths.map((path) => ({ path, isDir: false })));
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", cleanup);
  }, [serial, set]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const cur = order.indexOf(selection[selection.length - 1] ?? "");
    const go = (d: number) => {
      e.preventDefault();
      const n = Math.max(0, Math.min(order.length - 1, (cur < 0 ? (d > 0 ? -1 : order.length) : cur) + d));
      const next = order[n];
      if (!next) return;
      set({ selection: e.shiftKey ? [...new Set([...selection, next])] : [next], anchor: e.shiftKey ? useGallery.getState().anchor : next });
      const rowIdx = rows.findIndex((r) => r.type === "tiles" && r.items.some((i) => i.path === next));
      if (rowIdx >= 0) virt.scrollToIndex(rowIdx);
    };
    if (e.key === "ArrowRight") go(1);
    else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowDown") go(cols);
    else if (e.key === "ArrowUp") go(-cols);
    else if ((e.key === " " || e.key === "Enter") && selection.length) { e.preventDefault(); set({ viewer: selection[selection.length - 1] }); }
    else if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); set({ selection: order, anchor: order[0] ?? null }); }
    else if (mod && e.key.toLowerCase() === "c" && selection.length) { e.preventDefault(); void stageToClipboard(selection.map((path) => ({ path, isDir: false }))); }
    else if (e.key === "Escape") set({ selection: [], anchor: null });
  };

  const groupFor = (items: MediaItem[]) => items.map((i) => i.path);
  return (
    <div ref={scrollRef} data-scroll tabIndex={0} autoFocus role="grid" aria-label="Photos and videos" onKeyDown={onKeyDown} onClick={(e) => { if (e.target === e.currentTarget) set({ selection: [], anchor: null }); }} className="h-full overflow-auto px-3 outline-none">
      <div style={{ height: virt.getTotalSize(), position: "relative" }}>
        {virt.getVirtualItems().map((v) => {
          const row = rows[v.index];
          return (
            <div key={row.key} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: v.size, transform: `translateY(${v.start}px)` }}>
              {row.type === "header" ? (
                <div className="flex h-full items-end gap-2 pb-1.5">
                  {(() => {
                    const paths = groupFor(row.items);
                    const all = paths.every((p) => selSet.has(p));
                    return (
                      <>
                        <button aria-label={all ? `Deselect ${row.label}` : `Select ${row.label}`} onClick={() => set({ selection: all ? selection.filter((p) => !paths.includes(p)) : [...new Set([...selection, ...paths])] })} className={clsx("grid size-5 place-items-center rounded-full border-2", all ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--accent-ink)]" : "border-[var(--fg-muted)]")}>{all && <Check size={12} strokeWidth={3} />}</button>
                        <h2 className="text-[14px] font-semibold">{row.label}</h2>
                        <span className="text-[12px]" style={{ color: "var(--fg-muted)" }}>{row.items.length}</span>
                      </>
                    );
                  })()}
                </div>
              ) : (
                <div className="flex" style={{ gap: GAP }}>
                  {row.items.map((item) => <Tile key={item.path} item={item} serial={serial} size={size} selected={selSet.has(item.path)} onSelect={onSelect} onToggle={onToggle} onOpen={onOpen} onDown={onDown} />)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
