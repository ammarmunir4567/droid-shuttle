import { Command } from "cmdk";
import { useEffect } from "react";
import { Moon, Palette, Sun, SunMoon } from "lucide-react";
import { SECTIONS, type SectionId } from "../nav";
import { usePalette } from "../store/palette";
import { useAppearance } from "../theme/appearance";
import { VARIANT_LIST } from "../theme/variants";

export function CommandPalette({ onNavigate }: { onNavigate: (s: SectionId) => void }) {
  const { open, setOpen } = usePalette();
  const { setVariant, setTheme } = useAppearance();
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [setOpen]);
  const item = "flex items-center gap-3 rounded-lg px-3 py-2 data-[selected=true]:bg-[var(--selected)]";
  const run = (fn: () => void) => () => { fn(); setOpen(false); };
  return (
    <Command.Dialog open={open} onOpenChange={setOpen} label="Command palette" className="fixed left-1/2 top-24 z-50 w-[540px] -translate-x-1/2 overflow-hidden rounded-2xl border" >
      <div style={{ background: "var(--panel)", color: "var(--fg)", borderColor: "var(--border)", boxShadow: "var(--shadow-pop)" }}>
        <Command.Input placeholder="Go to a screen or change the look…" className="w-full border-b bg-transparent px-4 py-3 text-[14px] outline-none" style={{ borderColor: "var(--border)" }} />
        <Command.List className="max-h-96 overflow-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-center" style={{ color: "var(--fg-muted)" }}>Nothing matches that</Command.Empty>
          <Command.Group heading="Go to" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:text-[var(--fg-muted)]">
            {SECTIONS.map(({ id, label, icon: Icon, blurb }) => (
              <Command.Item key={id} value={`${label} ${blurb}`} onSelect={run(() => onNavigate(id))} className={item}>
                <Icon size={16} /> <span>{label}</span><span className="ml-auto truncate text-[12px]" style={{ color: "var(--fg-muted)" }}>{blurb}</span>
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading="Appearance" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:text-[var(--fg-muted)]">
            {VARIANT_LIST.map((v) => (
              <Command.Item key={v.id} value={`Look ${v.name} ${v.tagline}`} onSelect={run(() => setVariant(v.id))} className={item}>
                <Palette size={16} /> <span>Look: {v.name}</span><span className="ml-auto truncate text-[12px]" style={{ color: "var(--fg-muted)" }}>{v.tagline}</span>
              </Command.Item>
            ))}
            {([["auto", "Match the system", SunMoon], ["light", "Light", Sun], ["dark", "Dark", Moon]] as const).map(([id, label, Icon]) => (
              <Command.Item key={id} value={`Brightness ${label}`} onSelect={run(() => setTheme(id))} className={item}><Icon size={16} /> <span>Brightness: {label}</span></Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </div>
    </Command.Dialog>
  );
}
