import clsx from "clsx";
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, ChevronUp, Pause, Play, ShieldCheck, Unplug, X } from "lucide-react";
import { api, formatBytes, type TransferSnapshot } from "../lib/api";
import { useUi } from "../store/ui";
import { ShuttleHead } from "../brand/Logo";

const eta = (t: TransferSnapshot) => {
  if (t.speedBps < 1 || t.bytesTotal <= t.bytesDone) return "";
  const s = Math.round((t.bytesTotal - t.bytesDone) / t.speedBps);
  return s < 60 ? `${s}s left` : `${Math.floor(s / 60)}m ${s % 60}s left`;
};
const verb = (t: TransferSnapshot) => (t.direction === "pull" ? "Saving to Mac" : t.direction === "push" ? "Copying to phone" : t.direction.endsWith("Move") ? "Moving" : "Copying");

function Row({ t }: { t: TransferSnapshot }) {
  const live = t.finishedMs === null;
  const pct = t.bytesTotal ? Math.min(100, (t.bytesDone / t.bytesTotal) * 100) : t.status === "scanning" ? 0 : live ? 0 : 100;
  const failed = t.errors.length > 0;
  const waiting = live && t.status === "waiting";
  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg" style={{ background: "var(--selected)", color: failed ? "var(--color-danger)" : waiting ? "var(--color-warn)" : "var(--color-accent)" }}>
        {waiting ? <Unplug size={16} /> : !live ? (failed ? <AlertTriangle size={16} /> : <Check size={16} />) : t.direction === "pull" ? <ArrowDownToLine size={16} /> : <ArrowUpFromLine size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-medium">{t.label}</span>
          <span className="shrink-0 text-[11px]" style={{ color: "var(--fg-muted)" }}>
            {live ? (waiting ? "Waiting for your phone…" : t.status === "scanning" ? "Preparing…" : t.status === "paused" ? "Paused" : `${verb(t)} · ${t.filesDone}/${t.filesTotal || "…"}`) : t.status === "canceled" ? "Canceled" : failed ? `Finished with ${t.errors.length} error${t.errors.length > 1 ? "s" : ""}` : `Done · ${t.filesDone} file${t.filesDone === 1 ? "" : "s"}${t.filesSkipped ? `, ${t.filesSkipped} skipped` : ""}`}
            {!live && t.verified > 0 && !failed && <span className="ml-1 inline-flex items-center gap-0.5 text-[var(--color-ok)]"><ShieldCheck size={11} />verified</span>}
          </span>
        </div>
        {live ? (
          <>
            <div className="relative mt-1 h-1.5 rounded-full" style={{ background: "var(--border)" }}>
              <div className={clsx("h-full rounded-full transition-[width] duration-150", t.status === "paused" || waiting ? "bg-[var(--color-warn)]" : "bg-[var(--color-accent)]", t.status === "scanning" && "animate-pulse")} style={{ width: t.status === "scanning" ? "30%" : `${pct}%` }} />
              {t.status === "running" && pct > 0 && pct < 100 && <ShuttleHead className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: `${pct}%` }} />}
            </div>
            <div className="mt-0.5 flex gap-3 text-[11px] tabular-nums" style={{ color: "var(--fg-muted)" }}>
              <span>{formatBytes(t.bytesDone)} of {formatBytes(t.bytesTotal)}</span>
              {waiting && <span style={{ color: "var(--color-warn)" }}>Plug it back in and this continues where it stopped</span>}
              {t.speedBps > 0 && <span>{formatBytes(t.speedBps)}/s</span>}
              <span>{eta(t)}</span>
              {t.current && <span className="truncate">{t.current}</span>}
            </div>
          </>
        ) : failed && <div className="mt-0.5 truncate text-[11px] text-[var(--color-danger)]" title={t.errors.join("\n")}>{t.errors[0]}</div>}
      </div>
      {live && (
        <div className="flex gap-1">
          {t.bytesTotal > 0 && !waiting && <button aria-label={t.status === "paused" ? "Resume" : "Pause"} onClick={() => void (t.status === "paused" ? api.resumeTransfer(t.id) : api.pauseTransfer(t.id))} className="grid size-7 place-items-center rounded-md hover:bg-[var(--hover)]">{t.status === "paused" ? <Play size={14} /> : <Pause size={14} />}</button>}
          <button aria-label="Cancel" onClick={() => void api.cancelTransfer(t.id)} className="grid size-7 place-items-center rounded-md hover:bg-[var(--hover)]"><X size={14} /></button>
        </div>
      )}
    </li>
  );
}

export function TransferTray() {
  const { transfers, trayOpen, setTrayOpen, clearFinished } = useUi();
  const list = Object.values(transfers).sort((a, b) => (a.finishedMs === null ? -1 : 1) - (b.finishedMs === null ? -1 : 1) || b.id - a.id);
  if (!list.length) return null;
  const live = list.filter((t) => t.finishedMs === null);
  const speed = live.reduce((n, t) => n + t.speedBps, 0);
  const done = live.reduce((n, t) => n + t.bytesDone, 0), total = live.reduce((n, t) => n + t.bytesTotal, 0);
  const waitingCount = live.filter((t) => t.status === "waiting").length;
  return (
    <section aria-label="Transfers" className="shrink-0 border-t" style={{ borderColor: "var(--border)", background: "var(--bg-solid)" }}>
      <div className="flex h-9 items-center gap-3 px-4">
        <button onClick={() => setTrayOpen(!trayOpen)} className="flex items-center gap-2 font-medium" aria-expanded={trayOpen}>
          {trayOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          {waitingCount ? `Waiting for your phone · ${waitingCount} transfer${waitingCount > 1 ? "s" : ""} paused` : live.length ? `${live.length} transfer${live.length > 1 ? "s" : ""} in progress` : "Transfers"}
        </button>
        {live.length > 0 && total > 0 && <div className="relative h-1 w-40 rounded-full" style={{ background: "var(--border)" }}><div className={clsx("h-full rounded-full", waitingCount === live.length ? "bg-[var(--color-warn)]" : "bg-[var(--color-accent)]")} style={{ width: `${(done / total) * 100}%` }} /><ShuttleHead className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: `${Math.min(96, Math.max(4, (done / total) * 100))}%` }} /></div>}
        {speed > 0 && <span className="text-[11px] tabular-nums" style={{ color: "var(--fg-muted)" }}>{formatBytes(speed)}/s</span>}
        {live.length < list.length && <button onClick={() => { clearFinished(); void api.clearFinishedTransfers(); }} className="ml-auto text-[12px] text-[var(--color-accent)]">Clear finished</button>}
      </div>
      {trayOpen && <ul className="max-h-60 overflow-auto border-t" style={{ borderColor: "var(--border)" }}>{list.map((t) => <Row key={t.id} t={t} />)}</ul>}
    </section>
  );
}
