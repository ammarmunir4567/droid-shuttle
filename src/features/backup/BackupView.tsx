import { open as pickPath } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertTriangle, ArchiveRestore, CheckCircle2, FolderOpen, HardDrive, Loader2, Lock, ShieldCheck, Smartphone } from "lucide-react";
import { api, formatBytes, inTauri } from "../../lib/api";
import { baseName, plural } from "../../lib/paths";
import { useDevices } from "../../store/devices";
import { useBackup } from "../../store/backup";
import { useUi } from "../../store/ui";
import { Btn } from "../../components/Dialogs";
import { RestoreDialog } from "./RestoreDialog";

const toast = (kind: "info" | "ok" | "error", text: string, ms = 5000) => useUi.getState().toast({ kind, text }, ms);
const ago = (ms: number) => {
  const d = (ms - Date.now()) / 1000;
  const f = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, secs] of [["day", 86400], ["hour", 3600], ["minute", 60]] as const) if (Math.abs(d) >= secs) return f.format(Math.round(d / secs), unit);
  return "just now";
};
const dur = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

function FolderRow({ serial, path, label, checked, onToggle }: { serial: string; path: string; label: string; checked: boolean; onToggle: () => void }) {
  const [go, setGo] = useState(false);
  useEffect(() => { const t = setTimeout(() => setGo(true), 150); return () => clearTimeout(t); }, []);
  const size = useQuery({ queryKey: ["folderSize", serial, path], queryFn: () => api.backupFolderSize(serial, path), enabled: go, retry: false, staleTime: 5 * 60_000 });
  return (
    <label className="flex cursor-default items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-[var(--hover)]">
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <FolderOpen size={16} className="shrink-0 text-[var(--color-accent)]" />
      <span className="min-w-0 flex-1"><span className="font-medium">{label}</span>{path.replace("/sdcard/", "") !== label && <span className="ml-2 truncate text-[11px]" style={{ color: "var(--fg-muted)" }}>{path.replace("/sdcard/", "")}</span>}</span>
      <span className="w-20 text-right text-[12px] tabular-nums" style={{ color: "var(--fg-muted)" }}>{size.data != null ? formatBytes(size.data) : size.isError ? "—" : "measuring…"}</span>
    </label>
  );
}

export function BackupView() {
  const serial = useDevices((s) => s.selected)!;
  const device = useDevices((s) => s.devices.find((d) => d.serial === s.selected));
  // Same friendly name as the header ("Samsung SM-A075F"), and the name the backup folder gets.
  const { data: info } = useQuery({ queryKey: ["deviceInfo", serial], queryFn: () => api.deviceInfo(serial), staleTime: 60_000 });
  const deviceName = info ? `${info.manufacturer.charAt(0).toUpperCase()}${info.manufacturer.slice(1)} ${info.model}` : (device?.model ?? "Android phone");
  const b = useBackup();
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [restoring, setRestoring] = useState<{ path: string } | null>(null);

  const { data: folders = [] } = useQuery({ queryKey: ["backupFolders", serial], queryFn: () => api.backupFolders(serial), staleTime: 60_000 });
  const { data: history = [] } = useQuery({ queryKey: ["backupHistory", serial], queryFn: () => api.backupHistory(serial) });
  const { data: apps = [] } = useQuery({ queryKey: ["apps", serial], queryFn: () => api.appsList(serial), staleTime: 30_000 });
  const userApps = apps.filter((a) => !a.system);

  // Default destination: ~/Droid Shuttle Backups
  useEffect(() => { if (!b.destRoot) void api.localHome().then((h) => b.persist({ destRoot: `${h}/Droid Shuttle Backups` })); }, [b.destRoot]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: enc } = useQuery({ queryKey: ["backupEnc", b.destRoot, deviceName, serial], queryFn: () => api.backupEncryptedStatus(b.destRoot, deviceName, serial), enabled: !!b.destRoot });
  useEffect(() => { void api.backupRunning().then((r) => useBackup.getState().set({ running: r })); const un = api.onBackupStage((s) => useBackup.getState().set({ stage: s.detail })); return () => { void un.then((f) => f()); }; }, []);

  const selected = b.folders ?? folders.filter((f) => f.recommended).map((f) => f.path);
  const toggle = (path: string) => b.persist({ folders: selected.includes(path) ? selected.filter((p) => p !== path) : [...selected, path] });
  const appBytes = useMemo(() => userApps.reduce((n, a) => n + a.appSize, 0), [userApps]);
  const last = history[0];
  const needsPassword = b.encrypt && !enc?.exists;
  const pwProblem = needsPassword && (password.length < 6 ? "Use at least 6 characters" : password !== password2 ? "Passwords don't match" : "");
  const nothing = selected.length === 0 && !b.includeApps;

  const start = async () => {
    useBackup.getState().set({ running: true, stage: "Starting…" });
    try {
      const sum = await api.backupRun({ serial, deviceName, destRoot: b.destRoot, folders: selected, includeApps: b.includeApps, verify: b.verify, encrypt: b.encrypt, password: needsPassword ? password : undefined });
      setPassword(""); setPassword2("");
      if (sum.canceled) toast("info", "Backup canceled. What was copied is kept.");
      else if (sum.errors.length) useUi.getState().toast({ kind: "error", text: `Backup finished with ${plural(sum.errors.length, "problem")}: ${sum.errors[0]}` }, 10000);
      else useUi.getState().toast({ kind: "ok", text: sum.filesCopied ? `Backup complete — ${plural(sum.filesCopied, "file")} (${formatBytes(sum.bytes)}) copied` : "Backup complete — everything was already up to date", action: { label: "Show in Finder", run: () => void api.revealInFinder(sum.dest) } }, 12000);
    } catch (e) {
      toast("error", String(e), 10000);
    } finally {
      useBackup.getState().set({ running: false, stage: "" });
      void qc.invalidateQueries({ queryKey: ["backupHistory", serial] });
      void qc.invalidateQueries({ queryKey: ["backupEnc"] });
    }
  };

  const chooseDest = async () => {
    if (!inTauri) return;
    const d = await pickPath({ directory: true, defaultPath: b.destRoot || undefined, title: "Back up to…" });
    if (typeof d === "string") b.persist({ destRoot: d });
  };
  const openOther = async (encrypted: boolean) => {
    if (!inTauri) return;
    const p = await pickPath(encrypted ? { directory: false, filters: [{ name: "Encrypted backup", extensions: ["sparsebundle"] }], title: "Open encrypted backup" } : { directory: true, title: "Open backup folder" });
    if (typeof p === "string") setRestoring({ path: p });
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-6">
        <section className="flex items-center gap-4 rounded-2xl border p-5" style={{ borderColor: "var(--border)", background: "var(--panel)" }}>
          <span className="grid size-14 shrink-0 place-items-center rounded-2xl" style={{ background: "var(--selected)", color: "var(--color-accent)" }}><Smartphone size={26} /></span>
          <div className="min-w-0 flex-1">
            <h1 className="text-[18px] font-semibold">Back up {deviceName}</h1>
            <p className="text-[12px]" style={{ color: "var(--fg-muted)" }}>
              {last ? <><CheckCircle2 size={12} className="mr-1 inline text-[var(--color-ok)]" />Last backup {ago(last.startedMs)} · {formatBytes(last.bytes)} copied · {plural(last.filesCopied + last.filesSkipped, "file")} · took {dur(last.finishedMs - last.startedMs)}</> : "Never backed up. The first backup copies everything you select; after that only what changed."}
            </p>
            {b.running && <p className="mt-1 flex items-center gap-1.5 text-[12px]"><Loader2 size={12} className="animate-spin" />{b.stage || "Working…"} <span style={{ color: "var(--fg-muted)" }}>— progress is in the transfers bar below</span></p>}
          </div>
          {b.running ? <Btn danger onClick={() => void api.backupCancel()}>Cancel</Btn> : (
            <button disabled={nothing || !!pwProblem || !b.destRoot} onClick={() => void start()} className="rounded-lg bg-[var(--color-accent)] px-5 py-2.5 text-[14px] font-semibold text-[var(--accent-ink)] disabled:opacity-40">Back up now</button>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-[12px] font-medium " style={{ color: "var(--fg-muted)" }}>Back up to</h2>
          <div className="rounded-xl border p-3" style={{ borderColor: "var(--border)" }}>
            <div className="flex items-center gap-2">
              <HardDrive size={16} className="shrink-0 text-[var(--color-accent)]" />
              <span className="min-w-0 flex-1 select-text truncate" title={b.destRoot}>{b.destRoot || "…"}</span>
              <button onClick={() => void chooseDest()} className="rounded-md border px-2.5 py-1 text-[12px]" style={{ borderColor: "var(--border)" }}>Choose…</button>
            </div>
            <label className="mt-3 flex cursor-default items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={b.encrypt} disabled={b.running} onChange={(e) => b.persist({ encrypt: e.target.checked })} />
              <span><span className="flex items-center gap-1.5 font-medium"><Lock size={13} /> Encrypt this backup</span>
                <span className="block text-[12px]" style={{ color: "var(--fg-muted)" }}>Stored in an AES-256 encrypted disk image. {enc?.exists ? (enc.hasPassword ? "Its password is saved in your Keychain." : "Its password isn't in your Keychain — you'll be asked for it.") : "Choose a password below — it's saved in your Keychain and can't be recovered if you lose it."}</span></span>
            </label>
            {needsPassword && (
              <div className="mt-2 grid grid-cols-2 gap-2 pl-6">
                <input type="password" aria-label="Backup password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} className="rounded-md border bg-transparent px-2 py-1.5 outline-none" style={{ borderColor: "var(--border)" }} />
                <input type="password" aria-label="Confirm password" placeholder="Confirm password" value={password2} onChange={(e) => setPassword2(e.target.value)} className="rounded-md border bg-transparent px-2 py-1.5 outline-none" style={{ borderColor: "var(--border)" }} />
                {pwProblem && password.length > 0 && <p className="col-span-2 flex items-center gap-1 text-[12px] text-[var(--color-danger)]"><AlertTriangle size={12} />{pwProblem}</p>}
              </div>
            )}
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center gap-3">
            <h2 className="text-[12px] font-medium " style={{ color: "var(--fg-muted)" }}>What to back up</h2>
            <button className="text-[12px] text-[var(--color-accent)]" onClick={() => b.persist({ folders: folders.filter((f) => f.recommended).map((f) => f.path) })}>Recommended</button>
            <button className="text-[12px] text-[var(--color-accent)]" onClick={() => b.persist({ folders: folders.map((f) => f.path) })}>All</button>
            <button className="text-[12px] text-[var(--color-accent)]" onClick={() => b.persist({ folders: [] })}>None</button>
          </div>
          <div className="rounded-xl border p-1.5" style={{ borderColor: "var(--border)" }}>
            {folders.map((f) => <FolderRow key={f.path} serial={serial} path={f.path} label={f.label} checked={selected.includes(f.path)} onToggle={() => toggle(f.path)} />)}
            <label className="flex cursor-default items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-[var(--hover)]">
              <input type="checkbox" checked={b.includeApps} onChange={(e) => b.persist({ includeApps: e.target.checked })} />
              <ArchiveRestore size={16} className="shrink-0 text-[var(--color-accent)]" />
              <span className="min-w-0 flex-1"><span className="font-medium">Installed apps</span><span className="ml-2 text-[11px]" style={{ color: "var(--fg-muted)" }}>{plural(userApps.length, "app")} · installers only, not their data</span></span>
              <span className="w-20 text-right text-[12px] tabular-nums" style={{ color: "var(--fg-muted)" }}>{appBytes ? formatBytes(appBytes) : "—"}</span>
            </label>
          </div>
          <label className="mt-3 flex cursor-default items-start gap-2 px-1">
            <input type="checkbox" className="mt-0.5" checked={b.verify} onChange={(e) => b.persist({ verify: e.target.checked })} />
            <span><span className="flex items-center gap-1.5 font-medium"><ShieldCheck size={13} /> Verify every file after copying</span><span className="block text-[12px]" style={{ color: "var(--fg-muted)" }}>Compares SHA-256 checksums. Slower, but proves the copy is exact.</span></span>
          </label>
          <p className="mt-2 px-1 text-[12px]" style={{ color: "var(--fg-muted)" }}>Files you delete from your phone later stay in the backup — it never removes anything.</p>
        </section>

        <section>
          <div className="mb-2 flex items-center gap-3">
            <h2 className="text-[12px] font-medium " style={{ color: "var(--fg-muted)" }}>History</h2>
            <button className="text-[12px] text-[var(--color-accent)]" onClick={() => void openOther(false)}>Restore from a folder…</button>
            <button className="text-[12px] text-[var(--color-accent)]" onClick={() => void openOther(true)}>Restore from an encrypted backup…</button>
          </div>
          {history.length === 0 ? <p className="rounded-xl border px-4 py-6 text-center" style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}>No backups yet.</p> : (
            <ul className="divide-y rounded-xl border" style={{ borderColor: "var(--border)" }}>
              {history.map((h) => (
                <li key={h.id} className="flex items-center gap-3 px-4 py-2.5" style={{ borderColor: "var(--border)" }}>
                  {h.errors ? <AlertTriangle size={15} className="shrink-0 text-[var(--color-warn)]" /> : <CheckCircle2 size={15} className="shrink-0 text-[var(--color-ok)]" />}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{new Date(h.startedMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</div>
                    <div className="truncate text-[12px]" style={{ color: "var(--fg-muted)" }}>{formatBytes(h.bytes)} copied · {plural(h.filesCopied, "file")} new/changed · {h.apps ? plural(h.apps, "app") + " · " : ""}{baseName(h.dest)}{h.errors ? ` · ${plural(h.errors, "problem")}` : ""}</div>
                  </div>
                  <button onClick={() => void api.revealInFinder(h.dest)} className="rounded-md border px-2 py-1 text-[12px]" style={{ borderColor: "var(--border)" }}>Show in Finder</button>
                  <button onClick={() => setRestoring({ path: h.dest })} className={clsx("rounded-md border px-2 py-1 text-[12px]")} style={{ borderColor: "var(--border)" }}>Restore…</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {restoring && <RestoreDialog path={restoring.path} serial={serial} onClose={() => setRestoring(null)} />}
    </div>
  );
}
