import type { ReactNode } from "react";
import { SECTIONS, type SectionId } from "../nav";
import { TransferTray } from "../components/TransferTray";
import { Wordmark } from "../brand/Logo";
import { useVariant } from "../theme/appearance";
import { Rail, Sidebar, StatusBar, TopNav } from "./Nav";

interface ShellProps { section: SectionId; setSection: (s: SectionId) => void; ready: boolean; children: ReactNode }

function Title({ section, size }: { section: SectionId; size: "md" | "lg" }) {
  const s = SECTIONS.find((x) => x.id === section)!;
  const Icon = s.icon;
  if (size === "lg")
    return (
      <header className="flex h-[72px] shrink-0 items-center gap-4 px-7" data-tauri-drag-region>
        <span className="grid size-11 place-items-center rounded-2xl" style={{ background: "var(--selected)", color: "var(--color-accent)" }}><Icon size={22} strokeWidth={1.9} /></span>
        <div><h1 className="text-[24px] font-extrabold leading-tight tracking-tight">{s.label}</h1><p className="text-[13px]" style={{ color: "var(--fg-muted)" }}>{s.blurb}</p></div>
      </header>
    );
  return (
    <header className="flex h-12 shrink-0 items-baseline gap-3 border-b px-5 pt-3" style={{ borderColor: "var(--border)" }} data-tauri-drag-region>
      <h1 className="text-[17px] font-semibold tracking-tight">{s.label}</h1>
      <p className="truncate text-[12.5px]" style={{ color: "var(--fg-muted)" }}>{s.blurb}</p>
    </header>
  );
}

/** Picks the navigation structure for the chosen look and wraps the screen content in it. */
export function Shell({ section, setSection, ready, children }: ShellProps) {
  const { nav } = useVariant();
  const nav$ = { active: section, onSelect: setSection, disabled: !ready };

  if (nav === "rail")
    return (
      <div className="flex h-full flex-col" style={{ background: "var(--nav-bg)" }}>
        <div data-tauri-drag-region className="flex h-9 shrink-0 items-center justify-center text-[12px]" style={{ color: "var(--nav-fg-muted)" }}><Wordmark size={16} /></div>
        <div className="flex min-h-0 flex-1">
          <Rail {...nav$} />
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-[var(--radius-2xl)]" style={{ background: "var(--bg-solid)" }}>
            <main className={ready ? "min-h-0 flex-1" : "grid min-h-0 flex-1 place-items-center p-8"}>{children}</main>
            <TransferTray />
          </div>
        </div>
        <StatusBar />
      </div>
    );

  if (nav === "top")
    return (
      <div className="flex h-full flex-col" style={{ background: "var(--bg-solid)" }}>
        <TopNav {...nav$} />
        {ready && <Title section={section} size="lg" />}
        <div className="mx-3 mb-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-2xl)] border" style={{ background: "var(--panel)", borderColor: "var(--border)", boxShadow: "var(--shadow-card)" }}>
          <main className={ready ? "min-h-0 flex-1" : "grid min-h-0 flex-1 place-items-center p-8"}>{children}</main>
          <TransferTray />
        </div>
      </div>
    );

  return (
    <div className="flex h-full">
      <Sidebar {...nav$} />
      <div className="flex min-w-0 flex-1 flex-col" style={{ background: "var(--bg-solid)" }}>
        {ready ? <Title section={section} size="md" /> : <div data-tauri-drag-region className="h-8 shrink-0" />}
        <main className={ready ? "min-h-0 flex-1" : "grid min-h-0 flex-1 place-items-center p-8"}>{children}</main>
        <TransferTray />
      </div>
    </div>
  );
}
