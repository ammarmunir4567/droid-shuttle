import { useEffect, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { api, formatBytes, type Conflict, type OpenedBackup } from "../../lib/api";
import { plural } from "../../lib/paths";
import { Btn, Modal } from "../../components/Dialogs";
import { useUi, waitForTransfer } from "../../store/ui";

/** Open a backup (unlocking it if encrypted), pick what to put back, and restore it to the phone. */
export function RestoreDialog({ path, serial, onClose }: { path: string; serial: string; onClose: () => void }) {
  const encrypted = path.endsWith(".sparsebundle");
  const [password, setPassword] = useState("");
  const [opened, setOpened] = useState<OpenedBackup | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [apps, setApps] = useState<string[]>([]);
  const [conflict, setConflict] = useState<Conflict>("update");

  const open = async (pw?: string) => {
    setBusy(true); setErr(null);
    try {
      const o = await api.backupOpen(path, pw);
      setOpened(o);
      setFolders(o.contents.folders.map((f) => f.rel));
      setApps([]);
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  useEffect(() => { void open(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [path]);

  const finish = async () => {
    if (opened?.mounted) await api.backupClose(opened.root);
    onClose();
  };

  const start = async () => {
    if (!opened) return;
    const ui = useUi.getState();
    let jobId: number | null = null;
    try {
      if (folders.length) {
        jobId = await api.backupRestoreFiles({ serial, root: opened.root, folders, destBase: "/sdcard", conflict });
        ui.toast({ kind: "info", text: `Restoring ${plural(folders.length, "folder")} to your phone — see the transfers bar` }, 5000);
      }
      if (apps.length) {
        ui.toast({ kind: "info", text: `Installing ${plural(apps.length, "app")}…` }, 3000);
        const res = await api.backupRestoreApps(serial, opened.root, apps);
        for (const r of res) ui.toast(r.ok ? { kind: "ok", text: `Installed ${r.file}` } : { kind: "error", text: `${r.file}: ${r.message}` }, r.ok ? 4000 : 9000);
      }
    } catch (e) {
      ui.toast({ kind: "error", text: `Restore failed: ${String(e)}` }, 9000);
    }
    // An encrypted image has to stay unlocked until the files have finished copying out of it.
    const { root, mounted } = opened;
    onClose();
    if (mounted) void (async () => { if (jobId !== null) await waitForTransfer(jobId); await api.backupClose(root); })();
  };

  const total = (opened?.contents.folders ?? []).filter((f) => folders.includes(f.rel)).reduce((n, f) => n + f.bytes, 0);
  return (
    <Modal open onClose={() => void finish()} title="Restore from backup">
      {!opened ? (
        <div>
          <p className="mb-3 break-all text-[12px]" style={{ color: "var(--fg-muted)" }}>{path}</p>
          {encrypted && (
            <div className="mb-3">
              <label className="mb-1 flex items-center gap-1.5 text-[12px] font-medium"><Lock size={12} /> Password</label>
              <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void open(password)} aria-label="Backup password" className="w-full rounded-md border bg-transparent px-2 py-1.5 outline-none" style={{ borderColor: "var(--border)" }} />
            </div>
          )}
          {err && <p className="mb-3 text-[12px] text-[var(--color-danger)]">{err}</p>}
          {busy ? <p className="flex items-center gap-2 text-[12px]"><Loader2 size={13} className="animate-spin" /> Opening backup…</p> : encrypted && <div className="flex justify-end gap-2"><Btn onClick={() => void finish()}>Cancel</Btn><Btn primary onClick={() => void open(password)}>Unlock</Btn></div>}
          {!encrypted && err && <div className="flex justify-end"><Btn onClick={() => void finish()}>Close</Btn></div>}
        </div>
      ) : (
        <div>
          <p className="mb-3 text-[12px]" style={{ color: "var(--fg-muted)" }}>Files go back to their original places on your phone. Nothing on the phone is deleted.</p>
          <div className="mb-1 flex items-center gap-3"><span className="text-[12px] font-medium " style={{ color: "var(--fg-muted)" }}>Files</span>
            <button className="text-[12px] text-[var(--color-accent)]" onClick={() => setFolders(opened.contents.folders.map((f) => f.rel))}>All</button>
            <button className="text-[12px] text-[var(--color-accent)]" onClick={() => setFolders([])}>None</button></div>
          <div className="mb-3 max-h-44 overflow-auto rounded-lg border p-1" style={{ borderColor: "var(--border)" }}>
            {opened.contents.folders.length === 0 && <p className="p-3 text-center text-[12px]" style={{ color: "var(--fg-muted)" }}>No files in this backup.</p>}
            {opened.contents.folders.map((f) => (
              <label key={f.rel} className="flex cursor-default items-center gap-2 rounded px-2 py-1 hover:bg-[var(--hover)]">
                <input type="checkbox" checked={folders.includes(f.rel)} onChange={() => setFolders((s) => (s.includes(f.rel) ? s.filter((x) => x !== f.rel) : [...s, f.rel]))} />
                <span className="min-w-0 flex-1 truncate">{f.rel}</span><span className="text-[11px]" style={{ color: "var(--fg-muted)" }}>{plural(f.files, "file")} · {formatBytes(f.bytes)}</span>
              </label>
            ))}
          </div>
          {opened.contents.apps.length > 0 && (
            <>
              <div className="mb-1 flex items-center gap-3"><span className="text-[12px] font-medium " style={{ color: "var(--fg-muted)" }}>Apps (installers)</span>
                <button className="text-[12px] text-[var(--color-accent)]" onClick={() => setApps(opened.contents.apps.map((a) => a.dir))}>All</button>
                <button className="text-[12px] text-[var(--color-accent)]" onClick={() => setApps([])}>None</button></div>
              <div className="mb-3 max-h-40 overflow-auto rounded-lg border p-1" style={{ borderColor: "var(--border)" }}>
                {opened.contents.apps.map((a) => (
                  <label key={a.dir} className="flex cursor-default items-center gap-2 rounded px-2 py-1 hover:bg-[var(--hover)]">
                    <input type="checkbox" checked={apps.includes(a.dir)} onChange={() => setApps((s) => (s.includes(a.dir) ? s.filter((x) => x !== a.dir) : [...s, a.dir]))} />
                    <span className="min-w-0 flex-1 truncate">{a.label || a.package}</span><span className="text-[11px]" style={{ color: "var(--fg-muted)" }}>{a.versionName} · {formatBytes(a.bytes)}</span>
                  </label>
                ))}
              </div>
              <p className="mb-3 text-[11px]" style={{ color: "var(--fg-muted)" }}>Apps come back without their data and settings.</p>
            </>
          )}
          <div role="radiogroup" aria-label="If a file already exists" className="mb-4 grid grid-cols-2 gap-2">
            {([["update", "Skip identical files", "Recommended — copies only what's missing or different"], ["keepBoth", "Keep both", "Never overwrite a file on the phone"]] as [Conflict, string, string][]).map(([id, label, hint]) => (
              <button key={id} role="radio" aria-checked={conflict === id} onClick={() => setConflict(id)} className="rounded-lg border px-2 py-1.5 text-left" style={{ borderColor: conflict === id ? "var(--color-accent)" : "var(--border)", background: conflict === id ? "var(--selected)" : undefined }}>
                <div className="font-medium">{label}</div><div className="text-[10px]" style={{ color: "var(--fg-muted)" }}>{hint}</div>
              </button>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2">
            {total > 0 && <span className="mr-auto text-[12px]" style={{ color: "var(--fg-muted)" }}>{formatBytes(total)} to copy</span>}
            <Btn onClick={() => void finish()}>Cancel</Btn>
            <Btn primary autoFocus onClick={() => void start()}>{folders.length + apps.length ? "Restore" : "Nothing selected"}</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}
