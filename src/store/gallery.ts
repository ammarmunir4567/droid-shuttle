import { create } from "zustand";
import type { Organize } from "../lib/api";

export type MediaFilter = "all" | "photos" | "videos" | "screenshots";
export type Grouping = "day" | "month";

const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

interface GalleryStore {
  filter: MediaFilter;
  album: string | null;
  grouping: Grouping;
  tile: number;
  onlyNew: boolean;
  selection: string[]; // paths
  anchor: string | null;
  viewer: string | null; // path of the item open in the viewer
  importOpen: boolean;
  organize: Organize;
  deleteAfter: boolean;
  destDir: string;
  lastImportDest: string | null;
  set: (p: Partial<GalleryStore>) => void;
  persist: (p: Partial<Pick<GalleryStore, "grouping" | "tile" | "organize" | "destDir" | "onlyNew">>) => void;
}

export const useGallery = create<GalleryStore>((set) => ({
  filter: "all",
  album: null,
  grouping: load("db.g.grouping", "day"),
  tile: load("db.g.tile", 150),
  onlyNew: load("db.g.onlyNew", false),
  selection: [],
  anchor: null,
  viewer: null,
  importOpen: false,
  organize: load("db.g.organize", "month"),
  deleteAfter: false, // never remembered: deleting from the phone must be a deliberate choice each time
  destDir: load("db.g.dest", ""),
  lastImportDest: null,
  set: (p) => set(p),
  persist: (p) => {
    const keys: Record<string, string> = { grouping: "db.g.grouping", tile: "db.g.tile", organize: "db.g.organize", destDir: "db.g.dest", onlyNew: "db.g.onlyNew" };
    for (const [k, v] of Object.entries(p)) save(keys[k], v);
    set(p);
  },
}));
