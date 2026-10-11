import { create } from "zustand";
import { api, type DupGroup, type StorageProgress, type StorageSummary } from "../lib/api";

interface DupState { running: boolean; progress: StorageProgress | null; groups: DupGroup[] | null; minSize: number; error: string | null }

interface StorageStore {
  serial: string | null;
  summary: StorageSummary | null;
  scanning: boolean;
  progress: StorageProgress | null;
  error: string | null;
  /** Bumps whenever the scanned tree changes, so cached folder listings refetch. */
  version: number;
  dup: DupState;
  /** Bind to a phone; loads its last scan from the backend if there is one. */
  attach: (serial: string) => Promise<void>;
  scan: (serial: string) => Promise<void>;
  cancel: () => void;
  forget: (serial: string, paths: string[]) => Promise<void>;
  findDuplicates: (serial: string, minSize: number) => Promise<void>;
  setProgress: (p: StorageProgress) => void;
  setDupMinSize: (n: number) => void;
  dropGroupFiles: (paths: string[]) => void;
}

const idleDup = (minSize = 1_000_000): DupState => ({ running: false, progress: null, groups: null, minSize, error: null });
const isCancel = (e: unknown) => /cancel/i.test(String(e));

export const useStorage = create<StorageStore>((set, get) => ({
  serial: null,
  summary: null,
  scanning: false,
  progress: null,
  error: null,
  version: 0,
  dup: idleDup(),
  attach: async (serial) => {
    if (get().serial === serial) return;
    set({ serial, summary: null, scanning: false, progress: null, error: null, dup: idleDup(get().dup.minSize) });
    const summary = await api.storageSummary(serial).catch(() => null);
    if (get().serial === serial) set({ summary });
  },
  scan: async (serial) => {
    set({ serial, scanning: true, progress: null, error: null, dup: idleDup(get().dup.minSize) });
    try {
      const summary = await api.storageScan(serial);
      set((s) => ({ summary, scanning: false, progress: null, version: s.version + 1 }));
    } catch (e) {
      set({ scanning: false, progress: null, error: isCancel(e) ? null : String(e) });
    }
  },
  cancel: () => void api.storageCancel(),
  forget: async (serial, paths) => {
    const summary = await api.storageForget(serial, paths);
    set((s) => ({ summary: summary ?? s.summary, version: s.version + 1 }));
  },
  findDuplicates: async (serial, minSize) => {
    set((s) => ({ dup: { ...s.dup, running: true, progress: null, groups: null, error: null, minSize } }));
    try {
      const groups = await api.storageDuplicates(serial, minSize);
      set((s) => ({ dup: { ...s.dup, running: false, progress: null, groups } }));
    } catch (e) {
      set((s) => ({ dup: { ...s.dup, running: false, progress: null, error: isCancel(e) ? null : String(e) } }));
    }
  },
  setProgress: (p) => set((s) => (p.phase === "scan" ? { progress: p } : { dup: { ...s.dup, progress: p } })),
  setDupMinSize: (minSize) => set((s) => ({ dup: { ...s.dup, minSize } })),
  /** After files are deleted: drop them from the result list, and any set left with a single copy. */
  dropGroupFiles: (paths) =>
    set((s) => {
      if (!s.dup.groups) return s;
      const gone = new Set(paths);
      const groups = s.dup.groups.map((g) => ({ ...g, files: g.files.filter((f) => !gone.has(f.path)) })).filter((g) => g.files.length > 1);
      return { dup: { ...s.dup, groups } };
    }),
}));
