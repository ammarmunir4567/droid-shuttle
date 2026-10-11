import { open as pickDir } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Download, Loader2, PackagePlus, Play, RefreshCw, Search, Settings, Square, Trash2, X } from "lucide-react";
import { api, formatBytes, inTauri, toSrc, type AppInfo } from "../../lib/api";
import { installFiles, INSTALLABLE } from "../../lib/apps";
import { currentSerial } from "../../lib/ops";
import { plural } from "../../lib/paths";
import { refreshApps } from "../../lib/queryClient";
import { confirmDialog, confirmWithOption, useUi } from "../../store/ui";
import { useDevices } from "../../store/devices";
import { useVariant } from "../../theme/appearance";

type Filter = "user" | "system" | "disabled" | "all";
type Sort = "name" | "size" | "updated" | "installed";

const toast = (kind: "info" | "ok" | "error", text: string, ms = 4500) => useUi.getState().toast({ kind, text }, ms);

export const prettyName = (a: Pick<AppInfo, "label" | "package">) => {
  if (a.label) return a.label;
  const seg = a.package.split(".").filter((s) => !["com", "org", "net", "android", "app", "apps", "google", "samsung", "sec"].includes(s.toLowerCase())).pop() ?? a.package;
  return seg.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
};
const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const shortDate = (s: string) => {
  const d = new Date(s.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};
const installerName = (i: string) => ({ "com.android.vending": "Google Play", "com.sec.android.app.samsungapps": "Galaxy Store", "com.amazon.venezia": "Amazon Appstore" }[i] ?? (i || "Sideloaded / unknown"));

export function AppIcon({ app, size = 36 }: { app: AppInfo; size?: number }) {
  const [broken, setBroken] = useState(false);
  const name = prettyName(app);
  if (app.icon && !broken) return <img src={toSrc(app.icon)} alt="" width={size} height={size} draggable={false} onError={() => setBroken(true)} className="shrink-0 rounded-[22%]" style={{ width: size, height: size }} />;
  return (
    <span aria-hidden className="grid shrink-0 place-items-center rounded-[22%] font-semibold text-white" style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${hue(app.package)} 45% 48%)` }}>
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export function AppsView() {
  const serial = useDevices((s) => s.selected)!;
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("user");
  const [sort, setSort] = useState<Sort>("name");
  const [asc, setAsc] = useState(true);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const { appRowH } = useVariant();
  const scrollRef = useRef<HTMLDivElement>(null);
  const attempted = useRef(new Set<string>());

  const { data: apps = [], isLoading, isFetching, error } = useQuery({ queryKey: ["apps", serial], queryFn: () => api.appsList(serial), staleTime: 30_000 });

  // Names and icons stream in as the phone's APKs are read.
  useEffect(() => {
    const un = api.onAppMeta((m) => qc.setQueryData<AppInfo[]>(["apps", serial], (old) => old?.map((a) => (a.package === m.package ? { ...a, label: m.label || a.label, icon: m.icon ?? a.icon } : a))));
    return () => { void un.then((f) => f()); };
  }, [qc, serial]);

  const counts = useMemo(() => ({ user: apps.filter((a) => !a.system).length, system: apps.filter((a) => a.system).length, disabled: apps.filter((a) => a.disabled).length, all: apps.length }), [apps]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = apps.filter((a) => (filter === "all" || (filter === "user" && !a.system) || (filter === "system" && a.system) || (filter === "disabled" && a.disabled)) && (!q || prettyName(a).toLowerCase().includes(q) || a.package.toLowerCase().includes(q)));
    const dir = asc ? 1 : -1;
    return list.sort((a, b) => {
      const c = sort === "size" ? a.appSize + a.dataSize - (b.appSize + b.dataSize) : sort === "updated" ? a.lastUpdate.localeCompare(b.lastUpdate) : sort === "installed" ? a.firstInstall.localeCompare(b.firstInstall) : prettyName(a).localeCompare(prettyName(b), undefined, { sensitivity: "base" });
      return (c || a.package.localeCompare(b.package)) * dir;
    });
  }, [apps, filter, query, sort, asc]);

  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => appRowH, overscan: 8 });
  const visible = virt.getVirtualItems().map((v) => rows[v.index]).filter(Boolean);

  // Resolve names/icons for what's on screen (user apps first load; system apps as you scroll).
  const visibleKey = visible.map((a) => a.package).join("|");
  useEffect(() => {
    const t = setTimeout(() => {
      const todo = visible.filter((a) => !a.label && !attempted.current.has(a.package)).slice(0, 24);
      if (!todo.length) return;
      todo.forEach((a) => attempted.current.add(a.package));
      void api.appsResolve(serial, todo.map((a) => ({ package: a.package, apkPath: a.apkPath, versionCode: a.versionCode })));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, serial]);

  const selected = apps.filter((a) => sel.includes(a.package));
  const one = selected.length === 1 ? selected[0] : null;

  const click = (e: React.MouseEvent, a: AppInfo) => {
    if (e.shiftKey && anchor) {
      const i = rows.findIndex((r) => r.package === anchor), j = rows.findIndex((r) => r.package === a.package);
      return setSel(rows.slice(Math.min(i, j), Math.max(i, j) + 1).map((r) => r.package));
    }
    if (e.metaKey || e.ctrlKey) return setSel((s) => (s.includes(a.package) ? s.filter((x) => x !== a.package) : [...s, a.package]));
    setSel([a.package]);
    setAnchor(a.package);
  };
  const sortBy = (k: Sort) => (k === sort ? setAsc(!asc) : (setSort(k), setAsc(k === "name")));

  const installPicker = async () => {
    if (!inTauri) return;
    const picked = await pickDir({ multiple: true, filters: [{ name: "Android apps", extensions: INSTALLABLE }], title: "Install apps" });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length) void installFiles(paths);
  };

  const saveApks = async (list: AppInfo[]) => {
    if (!inTauri) return void api.appExtract(serial, list[0], "/tmp");
    const dest = await pickDir({ directory: true, title: "Save APKs to…" });
    if (typeof dest !== "string") return;
    for (const a of list) await api.appExtract(serial, a, dest).catch((e) => toast("error", `${prettyName(a)}: ${String(e)}`, 7000));
  };

  const uninstall = async (a: AppInfo) => {
    const name = prettyName(a);
    if (a.system) {
      const ok = await confirmDialog({ title: `Remove “${name}” from this phone?`, body: "This is a system app. It will be removed for your user account and may break features that depend on it. A factory reset brings it back. Disabling it instead is easier to undo.", confirmLabel: "Remove", danger: true });
      if (!ok) return;
      return act(() => api.appUninstall(serial, a.package, false, true), `Removed ${name}`);
    }
    const r = await confirmWithOption({ title: `Uninstall “${name}”?`, body: "The app will be removed from your phone.", option: "Keep the app's data and settings", confirmLabel: "Uninstall", danger: true });
    if (r.ok) await act(() => api.appUninstall(serial, a.package, r.checked, false), `Uninstalled ${name}`);
  };

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast("ok", ok); } catch (e) { toast("error", String(e), 8000); }
    void refreshApps();
  };

  const bulkUninstall = async () => {
    const targets = selected.filter((a) => !a.system);
    if (!targets.length) return toast("info", "System apps aren't removed in bulk — select them one at a time.");
    const r = await confirmWithOption({ title: `Uninstall ${plural(targets.length, "app")}?`, body: targets.slice(0, 6).map(prettyName).join(", ") + (targets.length > 6 ? `, and ${targets.length - 6} more` : ""), option: "Keep apps' data and settings", confirmLabel: "Uninstall", danger: true });
    if (!r.ok) return;
    let okN = 0;
    for (const a of targets) { try { await api.appUninstall(serial, a.package, r.checked, false); okN++; } catch (e) { toast("error", `${prettyName(a)}: ${String(e)}`, 7000); } }
    toast("ok", `Uninstalled ${plural(okN, "app")}`);
    setSel([]);
    void refreshApps();
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-3 border-b px-4" style={{ borderColor: "var(--border)" }}>
          <label className="flex h-7 w-56 items-center gap-1.5 rounded-md border px-2" style={{ borderColor: "var(--border)" }}>
            <Search size={13} style={{ color: "var(--fg-muted)" }} />
            <input aria-label="Search apps" placeholder="Search apps" value={query} onChange={(e) => setQuery(e.target.value)} className="min-w-0 flex-1 bg-transparent outline-none" />
          </label>
          <div role="radiogroup" aria-label="Show" className="flex overflow-hidden rounded-md border text-[12px]" style={{ borderColor: "var(--border)" }}>
            {([["user", "Apps"], ["system", "System"], ["disabled", "Disabled"], ["all", "All"]] as [Filter, string][]).map(([id, label]) => (
              <button key={id} role="radio" aria-checked={filter === id} onClick={() => setFilter(id)} className={clsx("px-2.5 py-1", filter === id && "bg-[var(--selected)] font-medium")}>{label} <span style={{ color: "var(--fg-muted)" }}>{counts[id]}</span></button>
            ))}
          </div>
          {(isFetching && !isLoading) && <Loader2 size={13} className="animate-spin" style={{ color: "var(--fg-muted)" }} />}
          <div className="ml-auto flex items-center gap-2">
            <button aria-label="Refresh" title="Refresh" onClick={() => void refreshApps()} className="grid size-7 place-items-center rounded-md hover:bg-[var(--hover)]"><RefreshCw size={14} /></button>
            <button onClick={() => void installPicker()} className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 font-medium text-[var(--accent-ink)]"><PackagePlus size={14} /> Install app…</button>
          </div>
        </div>

        {selected.length > 1 && (
          <div className="flex h-9 items-center gap-3 border-b px-4" style={{ borderColor: "var(--border)", background: "var(--selected)" }}>
            <span className="font-medium">{selected.length} selected</span>
            <button onClick={() => void saveApks(selected)} className="flex items-center gap-1 text-[12px] text-[var(--color-accent)]"><Download size={13} /> Save APKs…</button>
            <button onClick={() => void bulkUninstall()} className="flex items-center gap-1 text-[12px] text-[var(--color-danger)]"><Trash2 size={13} /> Uninstall…</button>
            <button aria-label="Clear selection" onClick={() => setSel([])} className="ml-auto"><X size={14} /></button>
          </div>
        )}

        <div role="row" className="grid shrink-0 items-center gap-3 border-b px-4 py-1.5 text-[11px] font-medium" style={{ gridTemplateColumns: "minmax(200px,1fr) 110px 90px 110px", borderColor: "var(--border)", color: "var(--fg-muted)" }}>
          {([["name", "Name"], [null, "Version"], ["size", "Size"], ["updated", "Updated"]] as [Sort | null, string][]).map(([k, label]) =>
            k ? <button key={label} onClick={() => sortBy(k)} className={clsx("flex items-center gap-1 text-left hover:text-[var(--fg)]", k === "size" && "justify-end")}>{label}{sort === k && (asc ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}</button> : <span key={label}>{label}</span>)}
        </div>

        <div ref={scrollRef} data-scroll role="grid" aria-label="Installed apps" className="min-h-0 flex-1 overflow-auto px-2 py-1" onClick={(e) => { if (e.target === e.currentTarget) setSel([]); }}>
          {error ? (
            <div className="grid h-full place-items-center text-center"><div><p className="font-medium">Couldn't read the app list</p><p className="text-[12px]" style={{ color: "var(--fg-muted)" }}>{String(error)}</p></div></div>
          ) : isLoading ? (
            <div className="grid h-full place-items-center" style={{ color: "var(--fg-muted)" }}><span className="flex items-center gap-2"><Loader2 className="animate-spin" size={16} /> Reading installed apps…</span></div>
          ) : rows.length === 0 ? (
            <div className="grid h-full place-items-center text-center" style={{ color: "var(--fg-muted)" }}><div><PackagePlus size={38} strokeWidth={1.2} className="mx-auto mb-2" /><p className="font-medium text-[var(--fg)]">{query ? "No matching apps" : "Nothing here"}</p><p className="text-[12px]">Drop an .apk file anywhere to install it.</p></div></div>
          ) : (
            <div style={{ height: virt.getTotalSize(), position: "relative" }}>
              {virt.getVirtualItems().map((v) => {
                const a = rows[v.index];
                const isSel = sel.includes(a.package);
                return (
                  <div key={a.package} role="row" aria-selected={isSel} onClick={(e) => click(e, a)} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: v.size, transform: `translateY(${v.start}px)`, gridTemplateColumns: "minmax(200px,1fr) 110px 90px 110px", background: isSel ? "var(--selected)" : undefined }} className="grid items-center gap-3 rounded-lg px-2">
                    <span className="flex min-w-0 items-center gap-3">
                      <AppIcon app={a} />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5"><span className={clsx("truncate font-medium", !a.label && "opacity-70")}>{prettyName(a)}</span>
                          {a.system && <span className="shrink-0 rounded bg-[var(--hover)] px-1 text-[10px]">System</span>}
                          {a.disabled && <span className="shrink-0 rounded bg-[var(--color-warn)]/25 px-1 text-[10px]">Disabled</span>}</span>
                        <span className="block truncate text-[11px]" style={{ color: "var(--fg-muted)" }}>{a.package}</span>
                      </span>
                    </span>
                    <span className="truncate" style={{ color: "var(--fg-muted)" }}>{a.versionName || "—"}</span>
                    <span className="text-right tabular-nums" style={{ color: "var(--fg-muted)" }}>{a.appSize ? formatBytes(a.appSize) : "—"}</span>
                    <span style={{ color: "var(--fg-muted)" }}>{shortDate(a.lastUpdate)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <footer className="flex h-7 shrink-0 items-center gap-3 border-t px-4 text-[11px]" style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}>
          <span>{plural(rows.length, "app")}</span>
          {filter === "user" && <span>{formatBytes(rows.reduce((n, a) => n + a.appSize + a.dataSize, 0))} used</span>}
        </footer>
      </div>

      {one && <DetailPanel key={one.package} app={one} onClose={() => setSel([])} onUninstall={uninstall} onSave={(a) => void saveApks([a])} act={act} />}
    </div>
  );
}

function DetailPanel({ app, onClose, onUninstall, onSave, act }: { app: AppInfo; onClose: () => void; onUninstall: (a: AppInfo) => void; onSave: (a: AppInfo) => void; act: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const serial = currentSerial() ?? "";
  const { data: d } = useQuery({ queryKey: ["appDetails", serial, app.package], queryFn: () => api.appDetails(serial, app.package), staleTime: 30_000 });
  const name = prettyName(app);
  const Btn = ({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) => (
    <button onClick={onClick} className={clsx("flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[12px] hover:bg-[var(--hover)]", danger && "text-[var(--color-danger)]")} style={{ borderColor: "var(--border)" }}>{children}</button>
  );
  return (
    <aside aria-label="App details" className="w-[330px] shrink-0 overflow-auto border-l p-4" style={{ borderColor: "var(--border)" }}>
      <div className="mb-3 flex items-start gap-3">
        <AppIcon app={app} size={56} />
        <div className="min-w-0 flex-1"><h2 className="truncate text-[16px] font-semibold">{name}</h2><p className="select-text break-all text-[11px]" style={{ color: "var(--fg-muted)" }}>{app.package}</p></div>
        <button aria-label="Close details" onClick={onClose}><X size={15} /></button>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-2">
        <Btn onClick={() => void act(() => api.appLaunch(serial, app.package), `Opened ${name} on your phone`)}><Play size={13} /> Open</Btn>
        <Btn onClick={() => void act(() => api.appForceStop(serial, app.package), `Stopped ${name}`)}><Square size={12} /> Force stop</Btn>
        <Btn onClick={() => onSave(app)}><Download size={13} /> Save APK…</Btn>
        <Btn onClick={() => void act(() => api.appOpenSettings(serial, app.package), "Opened app settings on your phone")}><Settings size={13} /> Phone settings</Btn>
      </div>
      <dl className="mb-4 grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5 text-[12px]">
        {[["Version", `${app.versionName || "—"} (${app.versionCode})`], ["Target SDK", String(app.targetSdk || "—")], ["Installed", shortDate(app.firstInstall)], ["Updated", shortDate(app.lastUpdate)], ["Source", installerName(app.installer)], ["App size", formatBytes(app.appSize)], ["Data", formatBytes(app.dataSize)], ["Cache", formatBytes(app.cacheSize)]].map(([k, v]) => (
          <div key={k} className="contents"><dt style={{ color: "var(--fg-muted)" }}>{k}</dt><dd className="select-text">{v}</dd></div>
        ))}
        <dt style={{ color: "var(--fg-muted)" }}>Package file{(d?.apkPaths.length ?? 1) > 1 ? "s" : ""}</dt>
        <dd className="select-text break-all font-mono text-[10px]">{(d?.apkPaths ?? [app.apkPath]).map((p) => <div key={p}>{p}</div>)}</dd>
      </dl>
      {d && (d.granted.length > 0 || d.denied.length > 0) && (
        <details className="mb-4 text-[12px]">
          <summary className="cursor-default font-medium">Permissions ({d.granted.length} allowed, {d.denied.length} denied)</summary>
          <div className="mt-2 flex flex-wrap gap-1">
            {d.granted.map((p) => <span key={p} className="rounded bg-[var(--color-ok)]/20 px-1.5 py-0.5 text-[10px]">{p.replace(/_/g, " ").toLowerCase()}</span>)}
            {d.denied.map((p) => <span key={p} className="rounded bg-[var(--hover)] px-1.5 py-0.5 text-[10px] line-through opacity-70">{p.replace(/_/g, " ").toLowerCase()}</span>)}
          </div>
        </details>
      )}
      <div className="grid grid-cols-2 gap-2">
        {app.disabled ? <Btn onClick={() => void act(() => api.appSetEnabled(serial, app.package, true), `Enabled ${name}`)}>Enable</Btn> : <Btn onClick={() => void act(() => api.appSetEnabled(serial, app.package, false), `Disabled ${name}`)}>Disable</Btn>}
        <Btn danger onClick={async () => { if (await confirmDialog({ title: `Clear all data for “${name}”?`, body: "Accounts, settings and saved files inside the app are erased. This can't be undone.", confirmLabel: "Clear data", danger: true })) void act(() => api.appClearData(serial, app.package), `Cleared data for ${name}`); }}>Clear data…</Btn>
        <button onClick={() => onUninstall(app)} className="col-span-2 flex items-center justify-center gap-1.5 rounded-md bg-[var(--color-danger)] px-2 py-1.5 text-[12px] font-medium text-[var(--accent-ink)]"><Trash2 size={13} /> {app.system ? "Remove for this user…" : "Uninstall…"}</button>
      </div>
    </aside>
  );
}
