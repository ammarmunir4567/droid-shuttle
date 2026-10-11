import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { CopyCheck, Loader2, PieChart, RefreshCw, ScanSearch, Weight, X } from "lucide-react";
import { api, formatBytes, type StorageCategory } from "../../lib/api";
import { useDevices } from "../../store/devices";
import { useStorage } from "../../store/storage";
import { Duplicates } from "./Duplicates";
import { LargeFiles } from "./LargeFiles";
import { Overview } from "./Overview";

const TABS = [
  { id: "map", label: "Map", icon: PieChart },
  { id: "large", label: "Large files", icon: Weight },
  { id: "dupes", label: "Duplicates", icon: CopyCheck },
] as const;
type Tab = (typeof TABS)[number]["id"];

const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 45 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

export function StorageView() {
  const serial = useDevices((s) => s.selected)!;
  const { summary, scanning, progress, error, attach, scan, cancel, setProgress } = useStorage();
  const [tab, setTab] = useState<Tab>("map");
  const [category, setCategory] = useState<StorageCategory | null>(null);
  const { data: info } = useQuery({ queryKey: ["deviceInfo", serial], queryFn: () => api.deviceInfo(serial) });

  useEffect(() => { void attach(serial); }, [serial, attach]);
  useEffect(() => {
    const un = api.onStorageProgress(setProgress);
    return () => { void un.then((f) => f()); };
  }, [setProgress]);

  const pickCategory = (c: StorageCategory | null) => { setCategory(c); setTab("large"); };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Storage" data-tauri-drag-region className="flex h-11 shrink-0 items-center gap-1 border-b px-3" style={{ borderColor: "var(--border)" }}>
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} disabled={!summary} className={clsx("flex items-center gap-1.5 rounded-md px-3 py-1.5 hover:bg-[var(--hover)] disabled:opacity-40", tab === id && "bg-[var(--selected)] font-medium")}>
            <Icon size={14} className={tab === id ? "text-[var(--color-accent)]" : ""} />{label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3">
          {info && info.storageTotal > 0 && <span className="text-[12px] tabular-nums" style={{ color: "var(--fg-muted)" }}>Phone: {formatBytes(info.storageUsed)} of {formatBytes(info.storageTotal)} used</span>}
          {summary && !scanning && <span className="text-[12px]" style={{ color: "var(--fg-muted)" }}>Scanned {ago(summary.finishedMs)}</span>}
          {scanning ? (
            <button onClick={cancel} className="flex h-8 items-center gap-1.5 rounded-md border px-3 hover:bg-[var(--hover)]" style={{ borderColor: "var(--border)" }}><X size={14} />Stop</button>
          ) : (
            <button onClick={() => void scan(serial)} className="flex h-8 items-center gap-1.5 rounded-md border px-3 hover:bg-[var(--hover)]" style={{ borderColor: "var(--border)" }}><RefreshCw size={14} />{summary ? "Scan again" : "Scan"}</button>
          )}
        </div>
      </div>

      {scanning && (
        <div role="status" className="flex items-center gap-3 border-b px-4 py-2" style={{ borderColor: "var(--border)", background: "var(--selected)" }}>
          <Loader2 size={14} className="animate-spin" />
          <span>Scanning your phone…</span>
          <span className="tabular-nums" style={{ color: "var(--fg-muted)" }}>{progress ? `${progress.files.toLocaleString()} files · ${formatBytes(progress.bytes)}` : "starting"}</span>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {!summary && !scanning ? (
          <div className="mx-auto mt-20 max-w-md text-center">
            <ScanSearch size={40} strokeWidth={1.2} className="mx-auto mb-3" style={{ color: "var(--color-accent)" }} />
            <h2 className="mb-1 text-[17px] font-semibold">See what's using your phone's space</h2>
            <p className="mb-4" style={{ color: "var(--fg-muted)" }}>Droid Shuttle reads the file list once and draws a map of your storage. Then you can find big files and duplicates. Scanning only reads; nothing changes.</p>
            {error && <p className="mb-3 text-[var(--color-danger)]">{error}</p>}
            <button onClick={() => void scan(serial)} className="h-9 rounded-md bg-[var(--color-accent)] px-5 font-medium text-[var(--accent-ink)]">Scan phone storage</button>
            <p className="mt-3 text-[12px]" style={{ color: "var(--fg-muted)" }}>Covers shared storage, the same files you see in Files. App data and system files aren't included.</p>
          </div>
        ) : summary ? (
          summary.totalFiles === 0 ? (
            <p className="mt-20 text-center" style={{ color: "var(--fg-muted)" }}>No files found in {summary.root}.</p>
          ) : tab === "map" ? <Overview serial={serial} summary={summary} onPickCategory={pickCategory} />
          : tab === "large" ? <LargeFiles serial={serial} category={category} onCategory={setCategory} />
          : <Duplicates serial={serial} />
        ) : null}
      </div>
    </div>
  );
}
