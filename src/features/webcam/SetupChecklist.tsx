import { AlertTriangle, Check, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import type { WebcamPrereqs } from "../../lib/api";
import { INSTALL, compatibilityNotes } from "./helpers";
import { Card, CodeLine, openLink } from "./parts";

function Row({ ok, pending, item }: { ok: boolean; pending: boolean; item: (typeof INSTALL)[keyof typeof INSTALL] }) {
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="grid size-5 shrink-0 place-items-center rounded-full" style={{ background: pending ? "var(--hover)" : `color-mix(in oklab, var(${ok ? "--color-ok" : "--color-warn"}) 18%, transparent)`, color: pending ? "var(--fg-muted)" : `var(${ok ? "--color-ok" : "--color-warn"})` }}>
          {pending ? <Loader2 size={12} className="animate-spin" /> : ok ? <Check size={13} strokeWidth={2.5} /> : <AlertTriangle size={12} />}
        </span>
        <span className="font-medium">{item.name}</span>
        <span className="ml-auto text-[12px]" style={{ color: "var(--fg-muted)" }}>{pending ? "Checking…" : ok ? "Found" : "Not found"}</span>
      </div>
      {!pending && !ok && (
        <div className="ml-7 flex flex-col gap-1.5">
          <p className="text-[12px]" style={{ color: "var(--fg-muted)" }}>{item.name === INSTALL.obs.name ? "Provides the virtual camera Zoom and Meet can pick." : "Provides the virtual microphone Zoom and Meet can pick."} Install with Homebrew or download it:</p>
          <CodeLine text={item.cmd} label={`${item.name} install command`} />
          <button type="button" onClick={() => openLink(item.url)} className="flex w-fit items-center gap-1 text-[12px] text-[var(--color-accent)] hover:underline"><ExternalLink size={12} /> Download {item.name}</button>
        </div>
      )}
    </li>
  );
}

/** What the Mac needs (OBS for the camera, BlackHole for the mic) and whether the phone is new enough. */
export function SetupChecklist({ prereqs, checking, onRecheck }: { prereqs: WebcamPrereqs | null; checking: boolean; onRecheck: () => void }) {
  const note = compatibilityNotes(prereqs);
  const pending = prereqs === null;
  return (
    <Card
      title="Set up your Mac"
      aside={
        <button type="button" onClick={onRecheck} disabled={checking} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] hover:bg-[var(--hover)] disabled:opacity-60" aria-label="Re-check">
          <RefreshCw size={12} className={checking ? "animate-spin" : undefined} /> Re-check
        </button>
      }
    >
      <ul className="flex flex-col gap-3">
        <Row ok={prereqs?.obsInstalled ?? false} pending={pending} item={INSTALL.obs} />
        <Row ok={prereqs?.blackholeInstalled ?? false} pending={pending} item={INSTALL.blackhole} />
      </ul>
      {note.camera && <div role="alert" className="mt-3 flex items-start gap-2 rounded-lg border p-2.5 text-[12px]" style={{ borderColor: "var(--color-danger)" }}><AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--color-danger)]" /><span>{note.camera}</span></div>}
    </Card>
  );
}
