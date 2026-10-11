import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as Ctx from "@radix-ui/react-context-menu";
import clsx from "clsx";
import { ArrowDown, ArrowUp, ArrowRightFromLine, FolderPlus, Info, Loader2, Monitor, Smartphone, UploadCloud } from "lucide-react";
import { api, formatBytes, formatDate, type FileEntry, type Side } from "../../lib/api";
import { kindOf } from "../../lib/fileKind";
import { copySelection, duplicateSelection, pasteInto } from "../../lib/clipboard";
import { createFolder, deleteEntries, openEntry, quickLook, renameEntry, runOp, transferViaPicker } from "../../lib/ops";
import { onRowPointerDown, targetKey, useDrag } from "../../lib/drag";
import { baseName, parentPath } from "../../lib/paths";
import { useDevices } from "../../store/devices";
import { useVariant } from "../../theme/appearance";
import { useFiles, type SortKey } from "../../store/files";
import { focusOtherPane, transferToOtherPane } from "../../lib/dual";
import { PathBar } from "./PathBar";

const TILE = 112;
const COLS = "minmax(180px,1fr) 88px 128px 120px";
const COLS_NARROW = "minmax(100px,1fr) 80px 110px";
const NARROW_PX = 600;

function sortEntries(list: FileEntry[], key: SortKey, asc: boolean) {
  const dir = asc ? 1 : -1;
  return [...list].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // folders first, like Finder
    let c = 0;
    if (key === "size") c = a.size - b.size;
    else if (key === "mtime") c = a.mtime - b.mtime;
    else if (key === "kind") c = kindOf(a.name, a.isDir).kind.localeCompare(kindOf(b.name, b.isDir).kind);
    return (c || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })) * (key === "name" ? dir : dir);
  });
}

interface RowProps {
  side: Side; entry: FileEntry; selected: boolean; hot: boolean; renaming: boolean; dim?: boolean;
  onClick: (e: React.MouseEvent, entry: FileEntry) => void;
  narrow?: boolean;
  rowH: number;
}

function RenameInput({ side, entry }: { side: Side; entry: FileEntry }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = entry.isDir ? -1 : entry.name.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  }, [entry]);
  return (
    <input
      ref={ref}
      defaultValue={entry.name}
      aria-label="Rename"
      className="w-full rounded border px-1 py-0.5 outline-none"
      style={{ borderColor: "var(--color-accent)", background: "var(--bg-solid)" }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") void renameEntry(side, entry, e.currentTarget.value);
        if (e.key === "Escape") useFiles.getState().patch(side, { renaming: null });
      }}
      onBlur={(e) => void renameEntry(side, entry, e.currentTarget.value)}
    />
  );
}

const ListRow = memo(function ListRow({ side, entry, selected, hot, renaming, onClick, narrow, dim, rowH }: RowProps) {
  const { icon: Icon, kind } = kindOf(entry.name, entry.isDir);
  return (
    <div
      role="row"
      aria-selected={selected}
      data-drop-side={entry.isDir ? side : undefined}
      data-drop-path={entry.isDir ? entry.path : undefined}
      data-drop-kind={entry.isDir ? "folder" : undefined}
      onPointerDown={(e) => onRowPointerDown(e, side, entry)}
      onClick={(e) => onClick(e, entry)}
      onDoubleClick={() => void openEntry(side, entry)}
      className={clsx("grid items-center gap-2 rounded-md px-2", hot && "ring-2 ring-[var(--color-accent)]", dim && "opacity-45")}
      style={{ height: rowH, gridTemplateColumns: narrow ? COLS_NARROW : COLS, background: hot || selected ? "var(--selected)" : undefined }}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon size={16} strokeWidth={1.6} className={entry.isDir ? "text-[var(--color-accent)]" : ""} style={entry.isDir ? undefined : { color: "var(--fg-muted)" }} />
        {renaming ? <RenameInput side={side} entry={entry} /> : <span className="truncate">{entry.name}</span>}
      </span>
      <span className="text-right tabular-nums" style={{ color: "var(--fg-muted)" }}>{entry.isDir ? "—" : formatBytes(entry.size)}</span>
      <span style={{ color: "var(--fg-muted)" }}>{formatDate(entry.mtime)}</span>
      {!narrow && <span className="truncate" style={{ color: "var(--fg-muted)" }}>{kind}</span>}
    </div>
  );
});

const GridTile = memo(function GridTile({ side, entry, selected, hot, renaming, onClick, dim }: RowProps) {
  const { icon: Icon } = kindOf(entry.name, entry.isDir);
  return (
    <div
      role="gridcell"
      aria-selected={selected}
      data-drop-side={entry.isDir ? side : undefined}
      data-drop-path={entry.isDir ? entry.path : undefined}
      data-drop-kind={entry.isDir ? "folder" : undefined}
      onPointerDown={(e) => onRowPointerDown(e, side, entry)}
      onClick={(e) => onClick(e, entry)}
      onDoubleClick={() => void openEntry(side, entry)}
      className={clsx("flex flex-col items-center gap-1 rounded-lg p-2", hot && "ring-2 ring-[var(--color-accent)]", dim && "opacity-45")}
      style={{ width: TILE, background: hot || selected ? "var(--selected)" : undefined }}
    >
      <Icon size={44} strokeWidth={1.1} className={entry.isDir ? "text-[var(--color-accent)]" : ""} style={entry.isDir ? undefined : { color: "var(--fg-muted)" }} />
      {renaming ? <RenameInput side={side} entry={entry} /> : <span className="line-clamp-2 w-full break-all text-center text-[12px] leading-tight">{entry.name}</span>}
    </div>
  );
});

export function FilePane({ side, title, home = "" }: { side: Side; title?: string; home?: string }) {
  const serial = useDevices((s) => s.selected);
  const pane = useFiles((s) => s.panes[side]);
  const { showHidden, active, dual, clipboard } = useFiles();
  const { navigate, patch, select, setEntries, setActive } = useFiles.getState();
  const dragKey = useDrag((s) => (s.target ? targetKey(s.target.side, s.target.path) : s.externalTarget ? targetKey(s.externalTarget.side, s.externalTarget.path) : ""));
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  // Local pane starts at the user's home folder.
  useEffect(() => {
    if (side === "local" && !pane.path) void api.localHome().then((h) => navigate("local", h, { replace: true }));
  }, [side, pane.path, navigate]);

  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["dir", side, serial, pane.path],
    queryFn: () => (side === "device" ? api.listDir(serial!, pane.path) : api.listLocal(pane.path)),
    enabled: !!pane.path && (side === "local" || !!serial),
    placeholderData: (prev) => prev,
  });

  const rows = useMemo(() => {
    let l = data ?? [];
    if (!showHidden) l = l.filter((e) => !e.name.startsWith("."));
    if (pane.query) l = l.filter((e) => e.name.toLowerCase().includes(pane.query.toLowerCase()));
    return sortEntries(l, pane.sortKey, pane.sortAsc);
  }, [data, showHidden, pane.query, pane.sortKey, pane.sortAsc]);

  useEffect(() => setEntries(side, rows), [rows, side, setEntries]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = Math.max(1, Math.floor((width - 16) / TILE));
  const isGrid = pane.view === "grid";
  const narrow = width < NARROW_PX;
  const { rowH } = useVariant();
  const count = isGrid ? Math.ceil(rows.length / cols) : rows.length;
  const virt = useVirtualizer({ count, getScrollElement: () => scrollRef.current, estimateSize: () => (isGrid ? 96 : rowH), overscan: 10 });

  const selSet = useMemo(() => new Set(pane.selection), [pane.selection]);
  const selected = rows.filter((r) => selSet.has(r.path));

  const onClick = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    const p = useFiles.getState().panes[side];
    const list = useFiles.getState().entries[side];
    if (e.shiftKey && p.anchor) {
      const a = list.findIndex((x) => x.path === p.anchor), b = list.findIndex((x) => x.path === entry.path);
      select(side, list.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path));
    } else if (e.metaKey || e.ctrlKey) {
      select(side, p.selection.includes(entry.path) ? p.selection.filter((x) => x !== entry.path) : [...p.selection, entry.path], entry.path);
    } else select(side, [entry.path], entry.path);
  }, [side, select]);

  const move = (delta: number, extend: boolean) => {
    if (!rows.length) return;
    const cur = rows.findIndex((r) => r.path === (pane.selection[pane.selection.length - 1] ?? ""));
    const next = Math.max(0, Math.min(rows.length - 1, cur < 0 ? (delta > 0 ? 0 : rows.length - 1) : cur + delta));
    const path = rows[next].path;
    select(side, extend ? [...new Set([...pane.selection, path])] : [path], extend ? pane.anchor : path);
    virt.scrollToIndex(isGrid ? Math.floor(next / cols) : next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (e.key === "Tab" && dual && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); focusOtherPane(); return; }
    const mod = e.metaKey || e.ctrlKey;
    const step = isGrid ? cols : 1;
    if (e.key === "ArrowDown") { e.preventDefault(); if (mod && selected[0]?.isDir) void openEntry(side, selected[0]); else move(step, e.shiftKey); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (mod) navigate(side, parentPath(pane.path)); else move(-step, e.shiftKey); }
    else if (isGrid && e.key === "ArrowRight") { e.preventDefault(); move(1, e.shiftKey); }
    else if (isGrid && e.key === "ArrowLeft") { e.preventDefault(); move(-1, e.shiftKey); }
    else if (e.key === "Enter" && selected.length === 1) { e.preventDefault(); patch(side, { renaming: selected[0].path }); }
    else if (e.key === " " && selected.length === 1) { e.preventDefault(); void quickLook(side, selected[0]); }
    else if ((e.key === "Backspace" || e.key === "Delete") && (mod || side === "device") && selected.length) { e.preventDefault(); void deleteEntries(side, selected); }
    else if (mod && e.key === "[") { e.preventDefault(); useFiles.getState().goBack(side); }
    else if (mod && e.key === "]") { e.preventDefault(); useFiles.getState().goForward(side); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); void createFolder(side, pane.path, data ?? []); }
    else if (e.key === "Escape") select(side, [], null);
  };

  const sortBy = (key: SortKey) => patch(side, { sortKey: key, sortAsc: pane.sortKey === key ? !pane.sortAsc : true });
  const bgHot = dragKey === targetKey(side, pane.path);
  const totalSel = selected.reduce((n, e) => n + (e.isDir ? 0 : e.size), 0);
  const restricted = /\/Android\/(data|obb)(\/|$)/.test(pane.path) && !rows.length && side === "device";

  return (
    <Ctx.Root>
      <Ctx.Trigger asChild>
        <section
          tabIndex={0}
          aria-label={side === "device" ? "Phone files" : "Mac files"}
          onKeyDown={onKeyDown}
          onPointerDownCapture={() => setActive(side)}
          onFocus={() => setActive(side)}
          data-pane={side}
          data-drop-side={side}
          data-drop-path={pane.path}
          data-drop-kind="pane"
          data-drop-label={baseName(pane.path)}
          className={clsx("relative flex min-h-0 min-w-0 flex-1 flex-col outline-none", dual && active === side && "shadow-[inset_0_2px_0_0_var(--color-accent)]")}
          style={bgHot ? { background: "var(--selected)" } : undefined}
        >
          {title && dual && (
            <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2" style={{ borderColor: "var(--border)" }}>
              <span className={clsx("mr-1 flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] font-semibold", active === side ? "bg-[var(--selected)] text-[var(--color-accent)]" : "")} style={active === side ? undefined : { color: "var(--fg-muted)" }}>
                {side === "device" ? <Smartphone size={13} /> : <Monitor size={13} />}<span className="max-w-28 truncate">{title}</span>
              </span>
              <PathBar side={side} home={home} />
            </div>
          )}
          {!isGrid && (
            <div role="row" className="grid shrink-0 gap-2 border-b px-4 py-1.5 text-[11px] font-medium" style={{ gridTemplateColumns: narrow ? COLS_NARROW : COLS, borderColor: "var(--border)", color: "var(--fg-muted)" }}>
              {([["name", "Name"], ["size", "Size"], ["mtime", "Modified"], ["kind", "Kind"]] as [SortKey, string][]).filter(([k]) => !(narrow && k === "kind")).map(([k, label]) => (
                <button key={k} onClick={() => sortBy(k)} className={clsx("flex items-center gap-1 text-left hover:text-[var(--fg)]", k === "size" && "justify-end")}>
                  {label}{pane.sortKey === k && (pane.sortAsc ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                </button>
              ))}
            </div>
          )}
          <div ref={scrollRef} data-scroll className="min-h-0 flex-1 overflow-auto px-2 py-1" onClick={(e) => { if (e.target === e.currentTarget) select(side, [], null); }}>
            {error ? (
              <div className="grid h-full place-items-center text-center"><div><Info className="mx-auto mb-2" />
                <p className="font-medium">Can't open this folder</p><p className="mb-3 max-w-sm text-[12px]" style={{ color: "var(--fg-muted)" }}>{String(error)}</p>
                <button onClick={() => void refetch()} className="rounded-md border px-3 py-1" style={{ borderColor: "var(--border)" }}>Try again</button></div></div>
            ) : !rows.length && !isFetching ? (
              <div className="grid h-full place-items-center text-center" style={{ color: "var(--fg-muted)" }}>
                <div>
                  <UploadCloud size={34} strokeWidth={1.2} className="mx-auto mb-2" />
                  <p>{pane.query ? "No matches" : restricted ? "Android restricts this folder" : "This folder is empty"}</p>
                  {!pane.query && <p className="text-[12px]">{restricted ? "Android 11+ blocks app folders from file managers." : "Drag files here from Finder"}</p>}
                </div>
              </div>
            ) : (
              <div style={{ height: virt.getTotalSize(), position: "relative" }}>
                {virt.getVirtualItems().map((v) => (
                  <div key={v.key} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start}px)`, height: v.size }} className={isGrid ? "flex gap-0" : undefined}>
                    {(isGrid ? rows.slice(v.index * cols, v.index * cols + cols) : [rows[v.index]]).map((entry) => {
                      const Row = isGrid ? GridTile : ListRow;
                      return <Row key={entry.path} rowH={rowH} dim={!!clipboard?.cut && clipboard.side === side && clipboard.paths.includes(entry.path)} narrow={narrow} side={side} entry={entry} selected={selSet.has(entry.path)} hot={entry.isDir && dragKey === targetKey(side, entry.path)} renaming={pane.renaming === entry.path} onClick={onClick} />;
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
          <footer className="flex h-7 shrink-0 items-center gap-3 border-t px-4 text-[11px]" style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}>
            {isFetching && <Loader2 size={12} className="animate-spin" />}
            <span>{rows.length} item{rows.length === 1 ? "" : "s"}</span>
            {selected.length > 0 && <span>{selected.length} selected{totalSel ? ` · ${formatBytes(totalSel)}` : ""}</span>}
          </footer>
        </section>
      </Ctx.Trigger>
      <Ctx.Portal>
        <Ctx.Content className="z-50 min-w-52 rounded-lg border p-1 shadow-xl" style={{ background: "var(--bg-solid)", borderColor: "var(--border)" }}>
          {selected.length > 0 ? (
            <>
              <Item onSelect={() => void openEntry(side, selected[0])} disabled={selected.length !== 1}>Open</Item>
              {selected.length === 1 && !selected[0].isDir && <Item onSelect={() => void quickLook(side, selected[0])}>Quick Look<kbd>Space</kbd></Item>}
              {dual && <Item onSelect={() => void transferToOtherPane("copy")}><ArrowRightFromLine size={14} /> Copy to {side === "device" ? "Mac" : "phone"} pane<kbd>F5</kbd></Item>}
              {dual && <Item onSelect={() => void transferToOtherPane("move")}>Move to {side === "device" ? "Mac" : "phone"} pane<kbd>F6</kbd></Item>}
              {side === "device" && <Item onSelect={() => void transferViaPicker("device", selected.map((s) => s.path))}>Save to Mac…</Item>}
              {side === "local" && serial && <Item onSelect={() => void runOp({ from: "local", to: "device", paths: selected.map((s) => s.path), destDir: useFiles.getState().panes.device.path, op: "copy" })}>Copy to phone</Item>}
              {side === "local" && <Item onSelect={() => void api.revealInFinder(selected[0].path)}>Reveal in Finder</Item>}
              <Item onSelect={() => void copySelection(side, false)}>Copy<kbd>⌘C</kbd></Item>
              <Item onSelect={() => void copySelection(side, true)}>Cut<kbd>⌘X</kbd></Item>
              <Item onSelect={() => void duplicateSelection(side)}>Duplicate<kbd>⌘D</kbd></Item>
              <Item onSelect={() => void navigator.clipboard.writeText(selected.map((s) => s.path).join("\n"))}>Copy path</Item>
              <Sep />
              <Item onSelect={() => patch(side, { renaming: selected[0].path })} disabled={selected.length !== 1}>Rename<kbd>↩</kbd></Item>
              <Item danger onSelect={() => void deleteEntries(side, selected)}>{side === "local" ? "Move to Trash" : "Delete…"}<kbd>⌘⌫</kbd></Item>
              <Sep />
            </>
          ) : null}
          <Item onSelect={() => void createFolder(side, pane.path, data ?? [])}><FolderPlus size={14} /> New folder<kbd>⇧⌘N</kbd></Item>
          <Item onSelect={() => void pasteInto(side)}>{clipboard ? `Paste ${clipboard.paths.length} item${clipboard.paths.length > 1 ? "s" : ""}` : "Paste"}<kbd>⌘V</kbd></Item>
          <Item onSelect={() => void refetch()}>Refresh</Item>
        </Ctx.Content>
      </Ctx.Portal>
    </Ctx.Root>
  );
}

function Item({ children, onSelect, disabled, danger }: { children: React.ReactNode; onSelect: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <Ctx.Item onSelect={onSelect} disabled={disabled} className={clsx("flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-[var(--color-accent)] data-[highlighted]:text-[var(--accent-ink)] [&_kbd]:ml-auto [&_kbd]:font-sans [&_kbd]:text-[11px] [&_kbd]:opacity-60", danger && "text-[var(--color-danger)]")}>
      {children}
    </Ctx.Item>
  );
}
const Sep = () => <Ctx.Separator className="my-1 h-px" style={{ background: "var(--border)" }} />;
