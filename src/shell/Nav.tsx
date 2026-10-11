import * as Tooltip from "@radix-ui/react-tooltip";
import clsx from "clsx";
import { BatteryCharging, ChevronsUpDown, Palette as PaletteIcon, Search, Smartphone, Usb, Wifi } from "lucide-react";
import { SECTIONS, type Section, type SectionId } from "../nav";
import { AppIcon, Wordmark } from "../brand/Logo";
import { formatBytes } from "../lib/api";
import { usePalette } from "../store/palette";
import { AppearanceMenu } from "./AppearanceMenu";
import { DeviceSwitcher } from "./DeviceSwitcher";
import { useDeviceSummary } from "./useDeviceSummary";

interface NavProps { active: SectionId; onSelect: (s: SectionId) => void; disabled: boolean }
const groups = ["Browse", "Manage"] as const;

/** Live phone status: which phone, how it's connected, battery and free space. */
export function DeviceCard() {
  const d = useDeviceSummary();
  if (!d.dev) {
    return (
      <div className="mb-4 flex items-center gap-3 rounded-xl border p-3" style={{ borderColor: "var(--border)", background: "var(--panel)" }}>
        <span className="grid size-9 place-items-center rounded-lg" style={{ background: "var(--surface-2)", color: "var(--fg-muted)" }}><Smartphone size={18} /></span>
        <div><div className="font-medium">No phone</div><div className="text-[12px]" style={{ color: "var(--fg-muted)" }}>Plug one in with a cable</div></div>
      </div>
    );
  }
  const low = d.usedPct > 90;
  return (
    <DeviceSwitcher>
      <button className="mb-5 w-full rounded-[12px] border p-3 text-left" style={{ borderColor: "var(--border)", background: "var(--panel)", boxShadow: "var(--shadow-card)" }} aria-label={d.count > 1 ? "Switch phone" : `${d.name}, connected`}>
        <div className="flex items-center gap-3">
          <span className="relative grid size-9 shrink-0 place-items-center rounded-lg" style={{ background: "var(--selected)", color: "var(--color-accent)" }}>
            <Smartphone size={18} />
            <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full ring-2" style={{ background: d.ready ? "var(--color-ok)" : "var(--color-warn)", ["--tw-ring-color" as string]: "var(--panel)" }} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1 font-semibold"><span className="truncate">{d.name}</span>{d.count > 1 && <ChevronsUpDown size={12} className="shrink-0" style={{ color: "var(--fg-muted)" }} />}</span>
            <span className="flex items-center gap-1 text-[12px]" style={{ color: "var(--fg-muted)" }}>{d.wireless ? <Wifi size={11} /> : <Usb size={11} />}{!d.ready ? "Waiting for approval" : d.wireless ? "Connected over Wi-Fi" : "Connected by cable"}</span>
          </span>
        </div>
        {d.ready && d.total > 0 && (
          <div className="mt-3">
            <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--border)" }}><div className="h-full rounded-full" style={{ width: `${d.usedPct}%`, background: low ? "var(--color-danger)" : "var(--color-accent)" }} /></div>
            <div className="mt-1.5 flex items-center justify-between text-[12px]" style={{ color: "var(--fg-muted)" }}>
              <span>{formatBytes(d.free)} free</span>
              <span className="flex items-center gap-1">{d.charging && <BatteryCharging size={12} className="text-[var(--color-ok)]" />}{d.battery ?? "–"}%</span>
            </div>
          </div>
        )}
      </button>
    </DeviceSwitcher>
  );
}

function SearchButton({ className }: { className?: string }) {
  const setOpen = usePalette((s) => s.setOpen);
  return (
    <button onClick={() => setOpen(true)} aria-label="Search and commands" className={clsx("flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] hover:bg-[var(--hover)]", className)} style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}>
      <Search size={13} /><span className="flex-1 text-left">Search</span><kbd className="font-sans text-[11px]">⌘K</kbd>
    </button>
  );
}

/* ───────── Studio: sidebar ───────── */
export function Sidebar({ active, onSelect, disabled }: NavProps) {
  return (
    <nav aria-label="Sections" className="relative flex w-[232px] shrink-0 flex-col border-r px-3 pb-3 pt-12" style={{ background: "var(--nav-bg)", borderColor: "var(--border)" }}>
      <div data-tauri-drag-region className="absolute left-[84px] top-[11px] text-[12.5px]"><Wordmark size={18} /></div>
      <DeviceCard />
      <div className="flex-1 overflow-auto">
        {groups.map((g) => (
          <div key={g} className="mb-4">
            <div className="px-2.5 pb-1.5 text-[12px] font-medium" style={{ color: "var(--fg-muted)" }}>{g}</div>
            <div className="flex flex-col gap-0.5">
              {SECTIONS.filter((s) => s.group === g).map(({ id, label, icon: Icon }) => {
                const on = active === id;
                return (
                  <button key={id} disabled={disabled} onClick={() => onSelect(id)} aria-current={on ? "page" : undefined}
                    className={clsx("flex h-8 w-full items-center gap-2.5 rounded-[9px] px-2.5 text-left transition-colors disabled:opacity-40", on ? "font-semibold" : "hover:bg-[var(--nav-hover)]")}
                    style={on ? { background: "var(--nav-active-bg)", boxShadow: "var(--nav-active-shadow), 0 0 0 1px var(--nav-active-ring)" } : { color: "var(--fg)" }}>
                    <Icon size={16} strokeWidth={on ? 2 : 1.75} className={on ? "text-[var(--color-accent)]" : ""} style={on ? undefined : { color: "var(--fg-muted)" }} />{label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1.5 pt-2">
        <SearchButton className="flex-1" />
        <AppearanceMenu side="top" align="end" />
      </div>
    </nav>
  );
}

/* ───────── Instrument: icon rail ───────── */
export function Rail({ active, onSelect, disabled }: NavProps) {
  const btn = "grid size-10 place-items-center rounded-lg transition-colors disabled:opacity-35";
  return (
    <Tooltip.Provider delayDuration={150}>
      <nav aria-label="Sections" className="flex w-14 shrink-0 flex-col items-center gap-1 py-2" style={{ background: "var(--nav-bg)", color: "var(--nav-fg)" }}>
        {groups.map((g, gi) => (
          <div key={g} className="flex flex-col items-center gap-1">
            {gi > 0 && <div className="my-1.5 h-px w-6" style={{ background: "rgb(255 255 255 / 0.12)" }} />}
            {SECTIONS.filter((s) => s.group === g).map(({ id, label, icon: Icon }) => (
              <Tooltip.Root key={id}>
                <Tooltip.Trigger asChild>
                  <button aria-label={label} disabled={disabled} onClick={() => onSelect(id)} aria-current={active === id ? "page" : undefined} className={clsx(btn, "relative hover:bg-[var(--nav-hover)]")} style={active === id ? { background: "var(--nav-hover)", color: "var(--color-accent)" } : undefined}>
                    {active === id && <span className="absolute -left-2 top-2 h-6 w-[3px] rounded-r-full" style={{ background: "var(--color-accent)" }} />}
                    <Icon size={19} strokeWidth={1.6} />
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content side="right" sideOffset={10} className="z-50 rounded-md px-2 py-1 text-[12px] font-medium" style={{ background: "var(--panel)", color: "var(--fg)", boxShadow: "var(--shadow-pop)", border: "1px solid var(--border)" }}>{label}</Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            ))}
          </div>
        ))}
        <div className="mt-auto flex flex-col items-center gap-1">
          <button aria-label="Search and commands" onClick={() => usePalette.getState().setOpen(true)} className={clsx(btn, "hover:bg-[var(--nav-hover)]")} style={{ color: "var(--nav-fg-muted)" }}><Search size={18} strokeWidth={1.6} /></button>
          <AppearanceMenu side="right" align="end">
            <button aria-label="Appearance" title="Appearance" className={clsx(btn, "hover:bg-[var(--nav-hover)]")} style={{ color: "var(--nav-fg-muted)" }}><PaletteIcon /></button>
          </AppearanceMenu>
        </div>
      </nav>
    </Tooltip.Provider>
  );
}
/** Instrument's bottom status bar: the phone's vitals, always visible. */
export function StatusBar() {
  const d = useDeviceSummary();
  return (
    <footer aria-label="Phone status" className="flex h-7 shrink-0 items-center gap-4 px-3 text-[11.5px]" style={{ background: "var(--nav-bg)", color: "var(--nav-fg-muted)" }}>
      <DeviceSwitcher>
        <button className="flex items-center gap-2 hover:text-[var(--nav-fg)]" aria-label={d.count > 1 ? "Switch phone" : "Phone"}>
          <span className="size-2 rounded-full" style={{ background: d.dev ? (d.ready ? "var(--color-ok)" : "var(--color-warn)") : "#5a554d", boxShadow: d.ready ? "0 0 6px var(--color-ok)" : undefined }} />
          <span style={{ color: "var(--nav-fg)" }}>{d.dev ? d.name : "No phone"}</span>
          {d.count > 1 && <ChevronsUpDown size={11} />}
        </button>
      </DeviceSwitcher>
      {d.ready && <>
        <span className="flex items-center gap-1">{d.wireless ? <Wifi size={11} /> : <Usb size={11} />}{d.wireless ? "Wi-Fi" : "USB"}</span>
        {d.android && <span>Android {d.android}</span>}
        <span className="flex items-center gap-1">{d.charging && <BatteryCharging size={11} style={{ color: "var(--color-accent)" }} />}{d.battery ?? "–"}%</span>
        {d.total > 0 && <span className="flex items-center gap-2">{formatBytes(d.free)} free<span className="h-1 w-16 overflow-hidden rounded-full" style={{ background: "rgb(255 255 255 / 0.14)" }}><span className="block h-full" style={{ width: `${d.usedPct}%`, background: "var(--color-accent)" }} /></span></span>}
      </>}
    </footer>
  );
}

/* ───────── Soft: pill tabs ───────── */
export function TopNav({ active, onSelect, disabled }: NavProps) {
  const d = useDeviceSummary();
  return (
    <nav aria-label="Sections" className="flex h-[60px] shrink-0 items-center gap-4 pl-[88px] pr-4" style={{ background: "var(--nav-bg)" }} data-tauri-drag-region>
      <AppIcon size={30} />
      <div className="flex items-center gap-1 rounded-full p-1" style={{ background: "var(--surface-2)" }}>
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button key={id} disabled={disabled} onClick={() => onSelect(id)} aria-current={active === id ? "page" : undefined}
            className={clsx("flex items-center gap-1.5 rounded-full px-3.5 py-1.5 font-semibold transition-colors disabled:opacity-40", active !== id && "hover:bg-[var(--hover)]")}
            style={active === id ? { background: "var(--color-accent)", color: "var(--accent-ink)", boxShadow: "var(--shadow-card)" } : { color: "var(--fg-muted)" }}>
            <Icon size={15} strokeWidth={2} style={active === id ? undefined : { color: `var(--sec-${id})` }} />{label}
          </button>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <SearchButton className="w-44 rounded-full" />
        <DeviceSwitcher>
          <button className="flex items-center gap-2 rounded-full border py-1 pl-1 pr-3" style={{ borderColor: "var(--border)", background: "var(--panel)", boxShadow: "var(--shadow-card)" }} aria-label={d.count > 1 ? "Switch phone" : `${d.name}`}>
            <span className="relative grid size-7 place-items-center rounded-full" style={{ background: "var(--selected)", color: "var(--color-accent)" }}><Smartphone size={14} /><span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full ring-2" style={{ background: d.ready ? "var(--color-ok)" : d.dev ? "var(--color-warn)" : "var(--border)", ["--tw-ring-color" as string]: "var(--panel)" }} /></span>
            <span className="text-[12.5px] font-semibold">{d.dev ? d.name : "No phone"}</span>
            {d.ready && <span className="flex items-center gap-1 text-[12px]" style={{ color: "var(--fg-muted)" }}>{d.charging && <BatteryCharging size={12} className="text-[var(--color-ok)]" />}{d.battery ?? "–"}%</span>}
          </button>
        </DeviceSwitcher>
        <AppearanceMenu side="bottom" align="end" />
      </div>
    </nav>
  );
}

export type { Section };
