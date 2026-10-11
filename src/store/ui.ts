import { create } from "zustand";
import type { Conflict, TransferSnapshot } from "../lib/api";

export interface Toast { id: number; kind: "info" | "ok" | "error"; text: string; action?: { label: string; run: () => void } }

export interface ConfirmReq { title: string; body: string; confirmLabel: string; danger?: boolean; option?: string; resolve: (ok: boolean, checked: boolean) => void }
export interface ConflictReq { names: string[]; destLabel: string; resolve: (c: Conflict | null) => void }
export interface ApkReq { paths: string[]; resolve: (choice: "install" | "copy" | null) => void }

interface UiStore {
  toasts: Toast[];
  confirm: ConfirmReq | null;
  conflict: ConflictReq | null;
  apk: ApkReq | null;
  transfers: Record<number, TransferSnapshot>;
  trayOpen: boolean;
  toast: (t: Omit<Toast, "id">, ms?: number) => number;
  dismiss: (id: number) => void;
  /** Change a toast in place (e.g. “Copying…” → “Copied”) instead of stacking a second one. */
  update: (id: number, patch: Partial<Omit<Toast, "id">>, ms?: number) => void;
  removeTransfer: (id: number) => void;
  setTransfer: (s: TransferSnapshot) => void;
  clearFinished: () => void;
  setTrayOpen: (o: boolean) => void;
  ask: <K extends "confirm" | "conflict" | "apk">(k: K, req: NonNullable<UiStore[K]>) => void;
  close: (k: "confirm" | "conflict" | "apk") => void;
}

let nextToast = 1;
export const useUi = create<UiStore>((set, get) => ({
  toasts: [],
  confirm: null,
  conflict: null,
  apk: null,
  transfers: {},
  trayOpen: true,
  toast: (t, ms = 4500) => {
    const id = nextToast++;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    if (ms > 0) setTimeout(() => get().dismiss(id), ms);
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  update: (id, patch, ms = 4500) => {
    let found = false;
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? ((found = true), { ...t, ...patch }) : t)) }));
    if (!found) get().toast({ kind: "info", text: "", ...patch }, ms); // it was dismissed meanwhile: show the result anyway
    else if (ms > 0) setTimeout(() => get().dismiss(id), ms);
  },
  removeTransfer: (id) => set((s) => { const { [id]: _gone, ...rest } = s.transfers; return { transfers: rest }; }),
  setTransfer: (snap) => set((s) => ({ transfers: { ...s.transfers, [snap.id]: snap }, trayOpen: s.transfers[snap.id] ? s.trayOpen : true })),
  clearFinished: () => set((s) => ({ transfers: Object.fromEntries(Object.entries(s.transfers).filter(([, t]) => t.finishedMs === null)) })),
  setTrayOpen: (trayOpen) => set({ trayOpen }),
  ask: (k, req) => set({ [k]: req } as Partial<UiStore>),
  close: (k) => set({ [k]: null } as Partial<UiStore>),
}));

/** Promise-style helpers over the dialog store. */
export const confirmDialog = (r: Omit<ConfirmReq, "resolve" | "option">) =>
  new Promise<boolean>((resolve) => useUi.getState().ask("confirm", { ...r, resolve: (ok) => resolve(ok) }));
/** Like `confirmDialog`, plus a checkbox (e.g. “Keep app data”). */
export const confirmWithOption = (r: Omit<ConfirmReq, "resolve"> & { option: string }) =>
  new Promise<{ ok: boolean; checked: boolean }>((resolve) => useUi.getState().ask("confirm", { ...r, resolve: (ok, checked) => resolve({ ok, checked }) }));
export const conflictDialog = (r: Omit<ConflictReq, "resolve">) =>
  new Promise<Conflict | null>((resolve) => useUi.getState().ask("conflict", { ...r, resolve }));
export const apkDialog = (paths: string[]) => new Promise<"install" | "copy" | null>((resolve) => useUi.getState().ask("apk", { paths, resolve }));

/** Resolves once the transfer job has finished (done or canceled). */
export const waitForTransfer = (id: number) =>
  new Promise<void>((resolve) => {
    const check = () => {
      const t = useUi.getState().transfers[id];
      if (t && t.finishedMs !== null) {
        unsub();
        resolve();
      }
    };
    const unsub = useUi.subscribe(check);
    check();
  });
