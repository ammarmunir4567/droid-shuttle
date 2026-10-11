import { useEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import clsx from "clsx";
import { Check, Copy } from "lucide-react";
import { inTauri } from "../../lib/api";
import { useWebcam } from "../../store/webcam";
import { useUi } from "../../store/ui";
import { meterFill } from "./helpers";

export const openLink = (url: string) => (inTauri ? void openUrl(url) : void window.open(url, "_blank", "noopener"));

/** The bordered option card used across the screen (same look as Mirror's option cards). */
export function Card({ title, aside, accent, children, className }: { title: string; aside?: ReactNode; accent?: boolean; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={clsx("rounded-xl border p-3", className)} style={{ borderColor: accent ? "var(--color-accent)" : "var(--border)", background: accent ? "var(--selected)" : undefined }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-[12px] font-medium" style={{ color: "var(--fg-muted)" }}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A row of mutually exclusive buttons (radio semantics, like Mirror's resolution picker). */
export function Seg<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button key={String(o.value)} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)} className="rounded-md border py-1 text-[12px] disabled:opacity-70" style={{ borderColor: on ? "var(--color-accent)" : "var(--border)", background: on ? "var(--selected)" : undefined }}>{o.label}</button>
        );
      })}
    </div>
  );
}

export const selectClass = "rounded-md border bg-transparent px-2 py-1 disabled:opacity-70";
export const borderStyle = { borderColor: "var(--border)" } as const;

/** Small icon button that copies `text` and shows a check for a moment. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setDone(false), 1500);
    } catch {
      useUi.getState().toast({ kind: "error", text: "Couldn't copy to the clipboard." });
    }
  };
  return (
    <button type="button" onClick={() => void copy()} aria-label={done ? `Copied ${label}` : `Copy ${label}`} title={done ? "Copied" : `Copy ${label}`} className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-[var(--hover)]">
      {done ? <Check size={14} className="text-[var(--color-ok)]" /> : <Copy size={14} />}
    </button>
  );
}

/** A command or URL in a monospace box with a copy button. */
export function CodeLine({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex items-center gap-1 rounded-lg border py-0.5 pl-2.5 pr-0.5" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
      <code className="min-w-0 flex-1 select-text truncate font-mono text-[12px]" title={text}>{text}</code>
      <CopyButton text={text} label={label} />
    </div>
  );
}

/** Live microphone level. Subscribes on its own so the ten-times-a-second updates don't re-render the whole screen. */
export function Meter() {
  const level = useWebcam((s) => s.level);
  const fill = meterFill(level);
  return (
    <div role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={Number(level.toFixed(3))} className="h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--hover)" }}>
      <div className="h-full rounded-full motion-safe:transition-[width] motion-safe:duration-75" style={{ width: `${Math.round(fill * 100)}%`, background: fill > 0.92 ? "var(--color-warn)" : "var(--color-ok)" }} />
    </div>
  );
}
