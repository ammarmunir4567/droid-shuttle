import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronRight, CornerLeftUp, ExternalLink, Folder, Trash2 } from "lucide-react";
import { api, formatBytes, formatDate, type StorageCategory, type StorageSummary, type TreeNode } from "../../lib/api";
import { useStorage } from "../../store/storage";
import { deleteFromPhone, showInFiles } from "./actions";
import { CATEGORY } from "./categories";
import { squarify } from "./treemap";

const pct = (n: number, of: number) => (of ? `${Math.max(0.1, (n / of) * 100).toFixed(n / of < 0.1 ? 1 : 0)}%` : "0%");

/** One stacked bar: what kinds of files fill the phone. Each legend entry opens that kind in “Large files”. */
function CategoryBar({ summary, onPick }: { summary: StorageSummary; onPick: (c: StorageCategory) => void }) {
  const cats = summary.categories.filter((c) => c.bytes > 0);
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full" style={{ background: "var(--border)" }} role="img" aria-label="Storage by file type">
        {cats.map((c) => <div key={c.id} title={`${CATEGORY[c.id].label}: ${formatBytes(c.bytes)}`} style={{ width: `${(c.bytes / summary.totalBytes) * 100}%`, background: CATEGORY[c.id].color }} />)}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {cats.map((c) => {
          const meta = CATEGORY[c.id];
          return (
            <li key={c.id}>
              <button onClick={() => onPick(c.id)} aria-label={`${meta.label}, ${formatBytes(c.bytes)}`} className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[12px] hover:bg-[var(--hover)]">
                <span className="size-2.5 rounded-sm" style={{ background: meta.color }} />
                <span>{meta.label}</span>
                <span className="tabular-nums" style={{ color: "var(--fg-muted)" }}>{formatBytes(c.bytes)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Tile({ node, w, h, selected, onSelect, onOpen }: { node: TreeNode; w: number; h: number; selected: boolean; onSelect: () => void; onOpen: () => void }) {
  const folded = !node.path;
  // Files are solid in their type's colour; folders are a soft wash of the type that fills them most.
  const hue = CATEGORY[node.category ?? "other"].color;
  const color = folded ? "var(--surface-2)" : node.isDir ? `color-mix(in oklab, ${hue} 26%, var(--surface-2))` : `color-mix(in oklab, ${hue} 82%, var(--panel))`;
  const showName = w > 64 && h > 26;
  const showSize = w > 64 && h > 44;
  return (
    <button
      aria-label={`${node.name}${node.isDir ? ", folder" : ""}, ${formatBytes(node.size)}${node.isDir ? `, ${node.files} files` : ""}`}
      aria-pressed={selected}
      disabled={folded}
      onClick={onSelect}
      onDoubleClick={() => node.isDir && onOpen()}
      onKeyDown={(e) => { if (e.key === "Enter" && node.isDir) { e.preventDefault(); onOpen(); } }}
      title={`${node.name} · ${formatBytes(node.size)}`}
      className="absolute inset-0 p-[1.5px] text-left outline-none"
    >
      <span
        className={clsx("flex h-full w-full flex-col overflow-hidden rounded-[var(--radius-md)] p-1.5 transition-[filter] hover:brightness-110", selected && "ring-2 ring-[var(--fg)]", folded && "opacity-60")}
        style={{ background: color, color: node.isDir || folded ? "var(--fg)" : "#fff" }}
      >
        {showName && (
          <span className="flex min-w-0 items-center gap-1 text-[12px] font-medium leading-tight">
            {node.isDir && <Folder size={12} className="shrink-0" style={{ color: hue }} />}<span className="truncate">{node.name}</span>
          </span>
        )}
        {showSize && <span className="mt-0.5 text-[11px] tabular-nums opacity-80">{formatBytes(node.size)}</span>}
      </span>
    </button>
  );
}

function TreeMap({ serial, path, selected, onSelect, onOpen }: { serial: string; path: string; selected: string | null; onSelect: (n: TreeNode | null) => void; onOpen: (p: string) => void }) {
  const version = useStorage((s) => s.version);
  const { data } = useQuery({ queryKey: ["storage-children", serial, path, version], queryFn: () => api.storageChildren(serial, path) });
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const tiles = useMemo(() => squarify((data ?? []).map((n) => ({ value: n.size, item: n })), { x: 0, y: 0, w: box.w, h: box.h }), [data, box]);
  return (
    <div ref={ref} className="relative min-h-[260px] flex-1" onClick={(e) => { if (e.target === e.currentTarget) onSelect(null); }} role="group" aria-label="Storage map">
      {data === null && <p className="absolute inset-0 grid place-items-center text-center" style={{ color: "var(--fg-muted)" }}>This folder is empty or was deleted.</p>}
      {tiles.map((t) => (
        <div key={t.item.path || t.item.name} className="absolute" style={{ left: t.x, top: t.y, width: t.w, height: t.h }}>
          <Tile node={t.item} w={t.w} h={t.h} selected={selected === t.item.path} onSelect={() => onSelect(t.item)} onOpen={() => onOpen(t.item.path)} />
        </div>
      ))}
    </div>
  );
}

export function Overview({ serial, summary, onPickCategory }: { serial: string; summary: StorageSummary; onPickCategory: (c: StorageCategory) => void }) {
  const [path, setPath] = useState(summary.root);
  const [sel, setSel] = useState<TreeNode | null>(null);
  const version = useStorage((s) => s.version);
  useEffect(() => { setPath(summary.root); setSel(null); }, [summary.root, serial]);
  // A deleted folder can leave us standing in nothing: step back out.
  const here = useQuery({ queryKey: ["storage-children", serial, path, version], queryFn: () => api.storageChildren(serial, path) });
  useEffect(() => { if (here.data === null && path !== summary.root) setPath(path.slice(0, path.lastIndexOf("/")) || summary.root); }, [here.data, path, summary.root]);

  const crumbs = useMemo(() => {
    const rel = path.slice(summary.root.length).split("/").filter(Boolean);
    return [{ label: "Internal storage", path: summary.root }, ...rel.map((seg, i) => ({ label: seg, path: `${summary.root}/${rel.slice(0, i + 1).join("/")}` }))];
  }, [path, summary.root]);
  const folderSize = here.data?.reduce((n, c) => n + c.size, 0) ?? 0;
  const open = (p: string) => { setPath(p); setSel(null); };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <CategoryBar summary={summary} onPick={onPickCategory} />
      <nav aria-label="Folder path" className="flex min-w-0 items-center gap-0.5 text-[13px]">
        <button aria-label="Up one folder" disabled={path === summary.root} onClick={() => open(path.slice(0, path.lastIndexOf("/")))} className="mr-1 grid size-7 place-items-center rounded-md hover:bg-[var(--hover)] disabled:opacity-30"><CornerLeftUp size={14} /></button>
        {crumbs.map((c, i) => (
          <span key={c.path} className="flex items-center">
            {i > 0 && <ChevronRight size={12} style={{ color: "var(--fg-muted)" }} />}
            <button onClick={() => open(c.path)} className={clsx("max-w-48 truncate rounded px-1.5 py-0.5 hover:bg-[var(--hover)]", i === crumbs.length - 1 && "font-semibold")}>{c.label}</button>
          </span>
        ))}
        <span className="ml-auto shrink-0 text-[12px] tabular-nums" style={{ color: "var(--fg-muted)" }}>{formatBytes(folderSize)} here</span>
      </nav>
      <div className="flex min-h-0 flex-1 gap-3">
        <TreeMap serial={serial} path={path} selected={sel?.path ?? null} onSelect={setSel} onOpen={open} />
        <aside aria-label="Details" className="flex w-64 shrink-0 flex-col gap-3 rounded-[var(--radius-xl)] border p-3" style={{ borderColor: "var(--border)", background: "var(--panel)" }}>
          {sel && sel.path ? (
            <>
              <div className="min-w-0">
                <h2 className="truncate text-[14px] font-semibold" title={sel.name}>{sel.name}</h2>
                <p className="break-all text-[11px]" style={{ color: "var(--fg-muted)" }}>{sel.path}</p>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                <dt style={{ color: "var(--fg-muted)" }}>Size</dt><dd className="tabular-nums">{formatBytes(sel.size)}</dd>
                <dt style={{ color: "var(--fg-muted)" }}>Share</dt><dd>{pct(sel.size, folderSize)} of this folder</dd>
                {sel.isDir ? <><dt style={{ color: "var(--fg-muted)" }}>Contains</dt><dd>{sel.files.toLocaleString()} file{sel.files === 1 ? "" : "s"}</dd></> : <><dt style={{ color: "var(--fg-muted)" }}>Kind</dt><dd>{CATEGORY[sel.category ?? "other"].label}</dd><dt style={{ color: "var(--fg-muted)" }}>Modified</dt><dd>{formatDate(sel.mtime)}</dd></>}
              </dl>
              <div className="mt-auto flex flex-col gap-1.5">
                {sel.isDir && <button onClick={() => open(sel.path)} className="flex h-8 items-center justify-center gap-1.5 rounded-md border hover:bg-[var(--hover)]" style={{ borderColor: "var(--border)" }}><Folder size={14} />Open folder</button>}
                <button onClick={() => showInFiles(sel.path, sel.isDir)} className="flex h-8 items-center justify-center gap-1.5 rounded-md border hover:bg-[var(--hover)]" style={{ borderColor: "var(--border)" }}><ExternalLink size={14} />Show in Files</button>
                <button onClick={() => void deleteFromPhone(serial, [{ path: sel.path, size: sel.size }]).then((ok) => ok && setSel(null))} className="flex h-8 items-center justify-center gap-1.5 rounded-md border text-[var(--color-danger)] hover:bg-[var(--hover)]" style={{ borderColor: "var(--border)" }}><Trash2 size={14} />Delete…</button>
              </div>
            </>
          ) : (
            <div className="my-auto text-center text-[12px]" style={{ color: "var(--fg-muted)" }}>
              <p className="mb-1 text-[13px] font-medium" style={{ color: "var(--fg)" }}>{formatBytes(folderSize)} in this folder</p>
              <p>Bigger tiles use more space. Click one for details, double-click a folder to look inside.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
