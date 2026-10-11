import { create } from "zustand";

const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

interface BackupStore {
  destRoot: string;
  /** null = "recommended folders" until the user changes the selection. */
  folders: string[] | null;
  includeApps: boolean;
  verify: boolean;
  encrypt: boolean;
  running: boolean;
  stage: string;
  set: (p: Partial<Omit<BackupStore, "set" | "persist">>) => void;
  persist: (p: Partial<Pick<BackupStore, "destRoot" | "folders" | "includeApps" | "verify" | "encrypt">>) => void;
}

export const useBackup = create<BackupStore>((set) => ({
  destRoot: load("db.b.dest", ""),
  folders: load<string[] | null>("db.b.folders", null),
  includeApps: load("db.b.apps", true),
  verify: load("db.b.verify", false),
  encrypt: load("db.b.encrypt", false),
  running: false,
  stage: "",
  set: (p) => set(p),
  persist: (p) => {
    const keys: Record<string, string> = { destRoot: "db.b.dest", folders: "db.b.folders", includeApps: "db.b.apps", verify: "db.b.verify", encrypt: "db.b.encrypt" };
    for (const [k, v] of Object.entries(p)) save(keys[k], v);
    set(p);
  },
}));
