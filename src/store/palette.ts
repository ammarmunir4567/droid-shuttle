import { create } from "zustand";

export const usePalette = create<{ open: boolean; setOpen: (o: boolean | ((c: boolean) => boolean)) => void }>((set) => ({
  open: false,
  setOpen: (o) => set((s) => ({ open: typeof o === "function" ? o(s.open) : o })),
}));
