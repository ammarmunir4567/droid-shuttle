import { create } from "zustand";
import { VARIANTS, type ThemeMode, type VariantId } from "./variants";

const KEY = "db.appearance";
interface Saved { variant: VariantId; theme: ThemeMode }

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Saved> | null;
    return { variant: v?.variant && v.variant in VARIANTS ? v.variant : "studio", theme: v?.theme === "light" || v?.theme === "dark" ? v.theme : "auto" };
  } catch { return { variant: "studio", theme: "auto" }; }
}

interface AppearanceStore extends Saved {
  setVariant: (v: VariantId) => void;
  setTheme: (t: ThemeMode) => void;
}

export const useAppearance = create<AppearanceStore>((set, get) => ({
  ...load(),
  setVariant: (variant) => { set({ variant }); persist({ variant, theme: get().theme }); apply({ variant, theme: get().theme }); },
  setTheme: (theme) => { set({ theme }); persist({ variant: get().variant, theme }); apply({ variant: get().variant, theme }); },
}));

function persist(s: Saved) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ } }

/** Reflect the choice on <html> so the CSS tokens switch. */
export function apply(s: Saved = useAppearance.getState()) {
  const el = document.documentElement;
  el.dataset.variant = s.variant;
  if (s.theme === "auto") delete el.dataset.theme; else el.dataset.theme = s.theme;
}

export const useVariant = () => VARIANTS[useAppearance((s) => s.variant)];
