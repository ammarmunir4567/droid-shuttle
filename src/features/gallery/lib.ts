import type { MediaItem } from "../../lib/api";
import type { Grouping, MediaFilter } from "../../store/gallery";

export const isScreenshot = (i: MediaItem) => /screenshot/i.test(i.bucket) || /\/Screenshots?\//i.test(i.path);

export function applyFilters(items: MediaItem[], f: { filter: MediaFilter; album: string | null; onlyNew: boolean }) {
  return items.filter((i) => {
    if (f.onlyNew && i.imported) return false;
    if (f.album && i.bucket !== f.album) return false;
    switch (f.filter) {
      case "photos": return i.kind === "image" && !isScreenshot(i);
      case "videos": return i.kind === "video";
      case "screenshots": return isScreenshot(i);
      default: return true;
    }
  });
}

export type GridRow =
  | { type: "header"; key: string; label: string; items: MediaItem[] }
  | { type: "tiles"; key: string; items: MediaItem[] };

export const groupLabel = (ms: number, g: Grouping) =>
  ms <= 0
    ? "Unknown date"
    : new Date(ms).toLocaleDateString(undefined, g === "month" ? { month: "long", year: "numeric" } : { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/** Items are already newest-first; split into date groups, then into rows of `cols` tiles. */
export function buildRows(items: MediaItem[], g: Grouping, cols: number): { rows: GridRow[]; groups: { label: string; items: MediaItem[] }[] } {
  const groups: { label: string; items: MediaItem[] }[] = [];
  for (const it of items) {
    const label = groupLabel(it.dateMs, g);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(it);
    else groups.push({ label, items: [it] });
  }
  const rows: GridRow[] = [];
  groups.forEach((grp, gi) => {
    rows.push({ type: "header", key: `h${gi}`, label: grp.label, items: grp.items });
    for (let i = 0; i < grp.items.length; i += cols) rows.push({ type: "tiles", key: `t${gi}-${i}`, items: grp.items.slice(i, i + cols) });
  });
  return { rows, groups };
}

export const formatDuration = (ms: number) => {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

export const fullDate = (ms: number) =>
  ms > 0 ? new Date(ms).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" }) : "Unknown date";
