import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ExternalLink, Trash2 } from "lucide-react";
import { api, formatBytes, formatDate, type StorageCategory } from "../../lib/api";
import { parentPath } from "../../lib/paths";
import { useStorage } from "../../store/storage";
import { deleteFromPhone, showInFiles } from "./actions";
import { CATEGORY } from "./categories";

const SIZES = [{ label: "Any size", min: 0 }, { label: "10 MB +", min: 10e6 }, { label: "100 MB +", min: 100e6 }, { label: "1 GB +", min: 1e9 }];

export function LargeFiles({ serial, category, onCategory }: { serial: string; category: StorageCategory | null; onCategory: (c: StorageCategory | null) => void }) {
  const version = useStorage((s) => s.version);
  const summary = useStorage((s) => s.summary);
  const [min, setMin] = useState(1);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { data: files = [], isFetching } = useQuery({ queryKey: ["storage-largest", serial, category, SIZES[min].min, version], queryFn: () => api.storageLargest(serial, category, SIZES[min].min, 300) });
  // Anything deleted elsewhere drops out of the selection.
  useEffect(() => setPicked((p) => new Set([...p].filter((x) => files.some((f) => f.path === x)))), [files]);

  const chosen = files.filter((f) => picked.has(f.path));
  const chosenSize = chosen.reduce((n, f) => n + f.size, 0);
  const toggle = (p: string) => setPicked((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const allOn = files.length > 0 && chosen.length === files.length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2" style={{ borderColor: "var(--border)" }}>
        <button onClick={() => onCategory(null)} aria-pressed={!category} className={clsx("rounded-full border px-3 py-1 text-[12px]", !category ? "border-transparent bg-[var(--color-accent)] text-[var(--accent-ink)]" : "hover:bg-[var(--hover)]")} style={category ? { borderColor: "var(--border)" } : undefined}>All types</button>
        {summary?.categories.filter((c) => c.bytes > 0).map((c) => (
          <button key={c.id} onClick={() => onCategory(c.id)} aria-pressed={category === c.id} className={clsx("flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px]", category === c.id ? "border-transparent bg-[var(--color-accent)] text-[var(--accent-ink)]" : "hover:bg-[var(--hover)]")} style={category === c.id ? undefined : { borderColor: "var(--border)" }}>
            <span className="size-2 rounded-full" style={{ background: CATEGORY[c.id].color }} />{CATEGORY[c.id].label}
          </button>
        ))}
        <select aria-label="Minimum size" value={min} onChange={(e) => setMin(Number(e.target.value))} className="ml-auto rounded-md border bg-transparent px-2 py-1 text-[12px]" style={{ borderColor: "var(--border)" }}>
          {SIZES.map((s, i) => <option key={s.label} value={i}>{s.label}</option>)}
        </select>
      </div>
      <div role="table" aria-label="Largest files" className="min-h-0 flex-1 overflow-auto px-2 py-1">
        <div role="row" className="grid grid-cols-[28px_minmax(0,1fr)_90px_110px_72px] items-center gap-2 px-2 py-1.5 text-[11px] font-medium" style={{ color: "var(--fg-muted)" }}>
          <input type="checkbox" aria-label="Select all" checked={allOn} onChange={() => setPicked(allOn ? new Set() : new Set(files.map((f) => f.path)))} />
          <span>Name</span><span className="text-right">Size</span><span>Modified</span><span />
        </div>
        {!files.length && !isFetching && <p className="py-12 text-center" style={{ color: "var(--fg-muted)" }}>No files match. Try a smaller size or another type.</p>}
        {files.map((f) => {
          const Icon = CATEGORY[f.category].icon;
          return (
            <div key={f.path} role="row" aria-selected={picked.has(f.path)} className="group grid grid-cols-[28px_minmax(0,1fr)_90px_110px_72px] items-center gap-2 rounded-md px-2 py-1.5" style={{ background: picked.has(f.path) ? "var(--selected)" : undefined }}>
              <input type="checkbox" aria-label={`Select ${f.name}`} checked={picked.has(f.path)} onChange={() => toggle(f.path)} />
              <span className="flex min-w-0 items-center gap-2">
                <Icon size={16} strokeWidth={1.6} style={{ color: CATEGORY[f.category].color }} className="shrink-0" />
                <span className="min-w-0"><span className="block truncate">{f.name}</span><span className="block truncate text-[11px]" style={{ color: "var(--fg-muted)" }}>{parentPath(f.path)}</span></span>
              </span>
              <span className="text-right tabular-nums">{formatBytes(f.size)}</span>
              <span style={{ color: "var(--fg-muted)" }}>{formatDate(f.mtime)}</span>
              <button aria-label={`Show ${f.name} in Files`} title="Show in Files" onClick={() => showInFiles(f.path, false)} className="ml-auto grid size-7 place-items-center rounded-md opacity-0 hover:bg-[var(--hover)] focus:opacity-100 group-hover:opacity-100"><ExternalLink size={14} /></button>
            </div>
          );
        })}
      </div>
      <div className="flex h-12 shrink-0 items-center gap-3 border-t px-4" style={{ borderColor: "var(--border)" }}>
        <span style={{ color: "var(--fg-muted)" }}>{chosen.length ? `${chosen.length} selected · ${formatBytes(chosenSize)}` : `${files.length} largest file${files.length === 1 ? "" : "s"} shown`}</span>
        <button disabled={!chosen.length} onClick={() => void deleteFromPhone(serial, chosen).then((ok) => ok && setPicked(new Set()))} className="ml-auto flex h-8 items-center gap-1.5 rounded-md bg-[var(--color-danger)] px-3 font-medium text-white disabled:opacity-40"><Trash2 size={14} />Delete{chosen.length ? ` ${chosen.length} file${chosen.length === 1 ? "" : "s"}` : ""}…</button>
      </div>
    </div>
  );
}
