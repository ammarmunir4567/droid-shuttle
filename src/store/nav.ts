import { create } from "zustand";
import type { SectionId } from "../nav";

export const useNav = create<{ section: SectionId; setSection: (s: SectionId) => void }>((set) => ({
  section: "files",
  setSection: (section) => set({ section }),
}));
