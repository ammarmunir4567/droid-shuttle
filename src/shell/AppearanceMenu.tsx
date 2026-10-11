import * as Popover from "@radix-ui/react-popover";
import clsx from "clsx";
import { Check, Moon, Palette, Sun, SunMoon } from "lucide-react";
import type { ReactNode } from "react";
import { AppIcon } from "../brand/Logo";
import { BRAND } from "../brand/brand";
import { useAppearance } from "../theme/appearance";
import { VARIANT_LIST, type ThemeMode, type VariantId } from "../theme/variants";

/** A tiny drawing of each layout, in its own colours, so the choice is visual. */
function Preview({ id }: { id: VariantId }) {
  const common = "relative h-16 w-full overflow-hidden rounded-lg border";
  if (id === "studio")
    return (
      <div className={common} style={{ background: "#f8f9fb", borderColor: "#e3e6ec" }} aria-hidden>
        <div className="absolute inset-y-0 left-0 w-1/4" style={{ background: "#eceff5" }}><div className="m-1.5 h-3 rounded" style={{ background: "#fff", boxShadow: "0 0 0 1px #e3e6ec" }} /><div className="mx-1.5 mt-1.5 h-1.5 rounded-sm" style={{ background: "#2f6bea33" }} /><div className="mx-1.5 mt-1 h-1.5 rounded-sm" style={{ background: "#d8dce4" }} /></div>
        <div className="absolute inset-y-0 left-1/4 right-0 p-2"><div className="mb-1.5 h-2 w-1/3 rounded-sm" style={{ background: "#1b1f27" }} />{[0, 1, 2].map((i) => <div key={i} className="mb-1 h-1.5 rounded-sm" style={{ background: i === 1 ? "#2f6bea33" : "#e8ebf0" }} />)}</div>
      </div>
    );
  if (id === "instrument")
    return (
      <div className={common} style={{ background: "#1b1a18", borderColor: "#35322e" }} aria-hidden>
        <div className="absolute inset-y-0 left-0 w-3.5" style={{ background: "#131211" }}>{[0, 1, 2, 3].map((i) => <div key={i} className="mx-auto mt-1.5 size-1.5 rounded-[2px]" style={{ background: i === 0 ? "#f2ab3c" : "#4a463f" }} />)}</div>
        <div className="absolute inset-y-0 left-3.5 right-0 p-1.5">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="mb-[3px] flex gap-1"><div className="h-1.5 flex-1 rounded-[1px]" style={{ background: i === 1 ? "#f2ab3c55" : "#2b2926" }} /><div className="h-1.5 w-4 rounded-[1px]" style={{ background: "#2b2926" }} /></div>)}</div>
        <div className="absolute inset-x-0 bottom-0 h-2" style={{ background: "#131211" }}><div className="ml-1 mt-[3px] size-1 rounded-full" style={{ background: "#5fd08a" }} /></div>
      </div>
    );
  return (
    <div className={common} style={{ background: "#f6f5fd", borderColor: "#e3e0f5" }} aria-hidden>
      <div className="mx-2 mt-1.5 flex gap-1 rounded-full p-0.5" style={{ background: "#edeafa" }}>{["#2f6fed", "#cc3a93", "#0c9462", "#d9650f"].map((c, i) => <div key={c} className="h-2 flex-1 rounded-full" style={{ background: i === 1 ? c : "transparent", boxShadow: i === 1 ? "none" : `inset 0 0 0 1px ${c}33` }} />)}</div>
      <div className="mx-2 mt-1.5 grid grid-cols-3 gap-1">{[0, 1, 2].map((i) => <div key={i} className="h-7 rounded-lg" style={{ background: "#fff", boxShadow: "0 3px 8px -3px rgb(70 58 140 / .3)" }} />)}</div>
    </div>
  );
}

const THEMES: { id: ThemeMode; label: string; icon: typeof Sun }[] = [
  { id: "auto", label: "Auto", icon: SunMoon },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
];

export function AppearanceMenu({ children, side = "top", align = "start" }: { children?: ReactNode; side?: "top" | "bottom" | "left" | "right"; align?: "start" | "end" | "center" }) {
  const { variant, theme, setVariant, setTheme } = useAppearance();
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        {children ?? <button aria-label="Appearance" title="Appearance" className="grid size-8 place-items-center rounded-lg hover:bg-[var(--hover)]"><Palette size={16} /></button>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side={side} align={align} sideOffset={8} aria-label="Appearance" className="z-50 w-[340px] rounded-2xl border p-3" style={{ background: "var(--panel)", color: "var(--fg)", borderColor: "var(--border)", boxShadow: "var(--shadow-pop)" }}>
          <div role="radiogroup" aria-label="Look" className="flex flex-col gap-2">
            {VARIANT_LIST.map((v) => (
              <button key={v.id} role="radio" aria-checked={variant === v.id} onClick={() => setVariant(v.id)} className={clsx("flex items-center gap-3 rounded-xl border p-2 text-left transition-colors hover:bg-[var(--hover)]")} style={{ borderColor: variant === v.id ? "var(--color-accent)" : "var(--border)", background: variant === v.id ? "var(--selected)" : undefined }}>
                <div className="w-28 shrink-0"><Preview id={v.id} /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 font-semibold">{v.name}{variant === v.id && <Check size={14} className="text-[var(--color-accent)]" />}</div>
                  <div className="text-[12px] leading-snug" style={{ color: "var(--fg-muted)" }}>{v.tagline}</div>
                </div>
              </button>
            ))}
          </div>
          <div role="radiogroup" aria-label="Brightness" className="mt-3 grid grid-cols-3 gap-1 rounded-xl p-1" style={{ background: "var(--surface-2)" }}>
            {THEMES.map(({ id, label, icon: Icon }) => (
              <button key={id} role="radio" aria-checked={theme === id} onClick={() => setTheme(id)} className="flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-[12px] font-medium" style={theme === id ? { background: "var(--panel)", boxShadow: "var(--shadow-card)" } : { color: "var(--fg-muted)" }}><Icon size={13} />{label}</button>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2 border-t pt-3 text-[12px]" style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}>
            <AppIcon size={20} /><span><b style={{ color: "var(--fg)" }}>{BRAND.name}</b> · free and open source</span>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
