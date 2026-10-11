export type VariantId = "studio" | "instrument" | "soft";
export type ThemeMode = "auto" | "light" | "dark";
export type NavStyle = "sidebar" | "rail" | "top";

export interface Variant {
  id: VariantId;
  name: string;
  tagline: string;
  nav: NavStyle;
  /** List row heights in px (virtualized lists need numbers, not CSS). */
  rowH: number;
  appRowH: number;
  gridGap: number;
}

export const VARIANTS: Record<VariantId, Variant> = {
  studio: { id: "studio", name: "Studio", tagline: "Native and calm, like it shipped with macOS", nav: "sidebar", rowH: 30, appRowH: 54, gridGap: 4 },
  instrument: { id: "instrument", name: "Instrument", tagline: "Dense and precise, built for power users", nav: "rail", rowH: 26, appRowH: 46, gridGap: 2 },
  soft: { id: "soft", name: "Soft", tagline: "Friendly and spacious, with a colour for each area", nav: "top", rowH: 40, appRowH: 64, gridGap: 8 },
};
export const VARIANT_LIST = Object.values(VARIANTS);
