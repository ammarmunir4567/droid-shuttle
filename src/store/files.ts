import { create } from "zustand";
import type { FileEntry, Side } from "../lib/api";

export type SortKey = "name" | "size" | "mtime" | "kind";
export type ViewMode = "list" | "grid";

export interface PaneState {
  path: string;
  back: string[];
  forward: string[];
  selection: string[]; // paths
  anchor: string | null;
  sortKey: SortKey;
  sortAsc: boolean;
  view: ViewMode;
  query: string;
  renaming: string | null;
}

const blank = (path = ""): PaneState => ({ path, back: [], forward: [], selection: [], anchor: null, sortKey: "name", sortAsc: true, view: "list", query: "", renaming: null });

interface FilesStore {
  panes: Record<Side, PaneState>;
  dual: boolean;
  /** Which pane sits on the left when two are shown. */
  layout: "phoneLeft" | "macLeft";
  /** Share of the width the left pane gets (0.25–0.75). */
  split: number;
  showHidden: boolean;
  verify: boolean;
  active: Side;
  clipboard: { side: Side; paths: string[]; cut: boolean; changeCount: number | null } | null;
  /** Latest listing per pane, kept so key handlers and drag code can resolve selection → entries. */
  entries: Record<Side, FileEntry[]>;
  setEntries: (side: Side, e: FileEntry[]) => void;
  navigate: (side: Side, path: string, opts?: { replace?: boolean }) => void;
  goBack: (side: Side) => void;
  goForward: (side: Side) => void;
  patch: (side: Side, p: Partial<PaneState>) => void;
  select: (side: Side, paths: string[], anchor?: string | null) => void;
  setActive: (s: Side) => void;
  toggle: (k: "dual" | "showHidden" | "verify") => void;
  swapPanes: () => void;
  setSplit: (n: number) => void;
  setClipboard: (c: FilesStore["clipboard"]) => void;
}

const load = <T,>(key: string, fallback: T): T => {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
};
const save = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } };

const clampSplit = (n: number) => (Number.isFinite(n) ? Math.min(0.75, Math.max(0.25, n)) : 0.5);

export const useFiles = create<FilesStore>((set, get) => ({
  panes: { device: blank("/sdcard"), local: blank("") },
  dual: load("db.dual", false),
  layout: load<"phoneLeft" | "macLeft">("db.layout", "phoneLeft"),
  split: clampSplit(load("db.split", 0.5)),
  showHidden: load("db.hidden", false),
  verify: load("db.verify", false),
  active: "device",
  clipboard: null,
  entries: { device: [], local: [] },
  setEntries: (side, e) => set((s) => ({ entries: { ...s.entries, [side]: e } })),
  navigate: (side, path, opts) =>
    set((s) => {
      const p = s.panes[side];
      if (p.path === path) return s;
      const next: PaneState = { ...p, path, selection: [], anchor: null, query: "", renaming: null, back: opts?.replace ? p.back : [...p.back, p.path].filter(Boolean), forward: [] };
      return { panes: { ...s.panes, [side]: next } };
    }),
  goBack: (side) =>
    set((s) => {
      const p = s.panes[side];
      if (!p.back.length) return s;
      const prev = p.back[p.back.length - 1];
      return { panes: { ...s.panes, [side]: { ...p, path: prev, back: p.back.slice(0, -1), forward: [p.path, ...p.forward], selection: [], anchor: null, query: "" } } };
    }),
  goForward: (side) =>
    set((s) => {
      const p = s.panes[side];
      if (!p.forward.length) return s;
      const [nxt, ...rest] = p.forward;
      return { panes: { ...s.panes, [side]: { ...p, path: nxt, back: [...p.back, p.path], forward: rest, selection: [], anchor: null, query: "" } } };
    }),
  patch: (side, p) => set((s) => ({ panes: { ...s.panes, [side]: { ...s.panes[side], ...p } } })),
  select: (side, paths, anchor) => set((s) => ({ panes: { ...s.panes, [side]: { ...s.panes[side], selection: paths, anchor: anchor === undefined ? s.panes[side].anchor : anchor } }, active: side })),
  setActive: (active) => set({ active }),
  toggle: (k) => {
    const v = !get()[k];
    save({ dual: "db.dual", showHidden: "db.hidden", verify: "db.verify" }[k], v);
    set({ [k]: v } as Partial<FilesStore>);
  },
  swapPanes: () => {
    const layout = get().layout === "phoneLeft" ? "macLeft" : "phoneLeft";
    save("db.layout", layout);
    set({ layout, split: 1 - get().split }); // keep each pane's width where it was
    save("db.split", get().split);
  },
  setSplit: (n) => {
    const split = clampSplit(n);
    save("db.split", split);
    set({ split });
  },
  setClipboard: (clipboard) => set({ clipboard }),
}));
