import { useMemo, useState } from "react";
import clsx from "clsx";
import { CopyCheck, ExternalLink, Loader2, Search, Trash2, X } from "lucide-react";
import { formatBytes, formatDate } from "../../lib/api";
import { parentPath } from "../../lib/paths";
import { useStorage } from "../../store/storage";
import { deleteFromPhone, showInFiles } from "./actions";
import { CATEGORY } from "./categories";
import { defaultChoices, deletions, reclaimable, type Choices, type KeepRule } from "./dupes";

const MIN_SIZES = [{ label: "100 KB +", v: 100e3 }, { label: "1 MB +", v: 1e6 }, { label: "10 MB +", v: 10e6 }];
const RULES: { id: KeepRule; label: string }[] = [{ id: "oldest", label: "Keep the oldest" }, { id: "newest", label: "Keep the newest" }, { id: "shortest", label: "Keep the shortest path" }];

function Progress() {
  const p = useStorage((s) => s.dup.progress);
  const cancel = useStorage((s) => s.cancel);
  const text = !p ? "Looking for files of the same size…" : p.phase === "fingerprint" ? "Comparing the start of each file…" : `Checking that copies are identical · ${formatBytes(p.bytes)} of ${formatBytes(p.total)}`;
  const pct = p?.phase === "hash" && p.total ? (p.bytes / p.total) * 100 : null;
  return (
    <div className="mx-auto mt-16 w-full max-w-md text-center" role="status">
      <Loader2 className="mx-auto mb-3 animate-spin" style={{ color: "var(--color-accent)" }} />
      <p className="mb-2">{text}</p>
      <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--border)" }}><div className={clsx("h-full rounded-full bg-[var(--color-accent)]", pct === null && "w-1/3 animate-pulse")} style={pct === null ? undefined : { width: `${pct}%` }} /></div>
      <p className="mt-2 text-[12px]" style={{ color: "var(--fg-muted)" }}>Your phone does the hashing, so big videos take a while. Nothing is changed.</p>
      <button onClick={cancel} className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 hover:bg-[var(--hover)]" style={{ borderColor: "var(--border)" }}><X size={14} />Cancel</button>
    </div>
  );
}

export function Duplicates({ serial }: { serial: string }) {
  const { dup, findDuplicates, setDupMinSize } = useStorage();
  const [rule, setRule] = useState<KeepRule>("oldest");
  const [choices, setChoices] = useState<Choices>({});
  const groups = dup.groups;
  // Re-derive choices whenever the result set (or the rule) changes, keeping each set's skip state.
  const current = useMemo(() => (groups ? defaultChoices(groups, rule, choices) : {}), [groups, rule]); // eslint-disable-line react-hooks/exhaustive-deps
  const effective: Choices = useMemo(() => ({ ...current, ...Object.fromEntries(Object.entries(choices).filter(([k]) => current[k])) }), [current, choices]);
  const gone = groups ? deletions(groups, effective) : [];
  const free = reclaimable(gone);
  const wasted = groups ? groups.reduce((n, g) => n + g.size * (g.files.length - 1), 0) : 0;

  const set = (hash: string, patch: Partial<Choices[string]>) => setChoices((c) => ({ ...effective, ...c, [hash]: { ...effective[hash], ...patch } }));
  const applyRule = (r: KeepRule) => { setRule(r); setChoices((c) => (groups ? defaultChoices(groups, r, { ...effective, ...c }) : c)); };

  if (dup.running) return <Progress />;
  if (!groups)
    return (
      <div className="mx-auto mt-16 max-w-md text-center">
        <CopyCheck size={36} strokeWidth={1.3} className="mx-auto mb-3" style={{ color: "var(--color-accent)" }} />
        <h2 className="mb-1 text-[16px] font-semibold">Find identical files</h2>
        <p className="mb-4" style={{ color: "var(--fg-muted)" }}>Finds photos, videos and documents that exist more than once, so you can keep one copy. Files are compared by content, not by name, and nothing is deleted until you confirm.</p>
        {dup.error && <p className="mb-3 text-[var(--color-danger)]">{dup.error}</p>}
        <div className="flex items-center justify-center gap-2">
          <select aria-label="Smallest file to check" value={dup.minSize} onChange={(e) => setDupMinSize(Number(e.target.value))} className="rounded-md border bg-transparent px-2 py-1.5" style={{ borderColor: "var(--border)" }}>
            {MIN_SIZES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
          </select>
          <button onClick={() => void findDuplicates(serial, dup.minSize)} className="flex h-9 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-4 font-medium text-[var(--accent-ink)]"><Search size={14} />Find duplicates</button>
        </div>
      </div>
    );

  if (!groups.length)
    return (
      <div className="mx-auto mt-16 max-w-md text-center">
        <CopyCheck size={36} strokeWidth={1.3} className="mx-auto mb-3 text-[var(--color-ok)]" />
        <h2 className="mb-1 text-[16px] font-semibold">No duplicates found</h2>
        <p className="mb-4" style={{ color: "var(--fg-muted)" }}>Every file of {formatBytes(dup.minSize)} or more is unique.</p>
        <button onClick={() => void findDuplicates(serial, dup.minSize)} className="rounded-md border px-3 py-1.5 hover:bg-[var(--hover)]" style={{ borderColor: "var(--border)" }}>Check again</button>
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2" style={{ borderColor: "var(--border)" }}>
        <span><b>{groups.length}</b> set{groups.length === 1 ? "" : "s"} of identical files · <b>{formatBytes(wasted)}</b> wasted</span>
        <select aria-label="Which copy to keep" value={rule} onChange={(e) => applyRule(e.target.value as KeepRule)} className="ml-auto rounded-md border bg-transparent px-2 py-1 text-[12px]" style={{ borderColor: "var(--border)" }}>
          {RULES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <button onClick={() => void findDuplicates(serial, dup.minSize)} className="rounded-md border px-2.5 py-1 text-[12px] hover:bg-[var(--hover)]" style={{ borderColor: "var(--border)" }}>Check again</button>
      </div>
      <ul aria-label="Duplicate sets" className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
        {groups.map((g) => {
          const c = effective[g.hash];
          const Icon = CATEGORY[g.files[0].category].icon;
          return (
            <li key={g.hash} className="overflow-hidden rounded-[var(--radius-xl)] border" style={{ borderColor: "var(--border)", background: "var(--panel)", opacity: c?.skip ? 0.55 : 1 }}>
              <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
                <Icon size={15} style={{ color: CATEGORY[g.files[0].category].color }} />
                <span className="font-medium">{g.files.length} copies · {formatBytes(g.size)} each</span>
                <label className="ml-auto flex items-center gap-1.5 text-[12px]" style={{ color: "var(--fg-muted)" }}>
                  <input type="checkbox" checked={!c?.skip} onChange={(e) => set(g.hash, { skip: !e.target.checked })} aria-label={`Clean up ${g.files[0].name}`} />Clean up this set
                </label>
              </div>
              <ul role="radiogroup" aria-label={`Copies of ${g.files[0].name}`}>
                {g.files.map((f) => {
                  const keep = c?.keep === f.path;
                  return (
                    <li key={f.path} className="flex items-center gap-3 px-3 py-1.5">
                      <input type="radio" name={`keep-${g.hash}`} checked={keep} onChange={() => set(g.hash, { keep: f.path })} aria-label={`Keep ${f.path}`} />
                      <span className="min-w-0 flex-1"><span className="block truncate">{f.name}</span><span className="block truncate text-[11px]" style={{ color: "var(--fg-muted)" }}>{parentPath(f.path)} · {formatDate(f.mtime)}</span></span>
                      <span className={clsx("w-16 shrink-0 text-right text-[11px] font-medium", keep || c?.skip ? "text-[var(--color-ok)]" : "text-[var(--color-danger)]")}>{keep || c?.skip ? "Keep" : "Delete"}</span>
                      <button aria-label={`Show ${f.name} in Files`} title="Show in Files" onClick={() => showInFiles(f.path, false)} className="grid size-7 place-items-center rounded-md hover:bg-[var(--hover)]"><ExternalLink size={14} /></button>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
      <div className="flex h-12 shrink-0 items-center gap-3 border-t px-4" style={{ borderColor: "var(--border)" }}>
        <span style={{ color: "var(--fg-muted)" }}>One copy of every set is always kept.</span>
        <button disabled={!gone.length} onClick={() => void deleteFromPhone(serial, gone)} className="ml-auto flex h-8 items-center gap-1.5 rounded-md bg-[var(--color-danger)] px-3 font-medium text-white disabled:opacity-40"><Trash2 size={14} />{gone.length ? `Delete ${gone.length} cop${gone.length === 1 ? "y" : "ies"} · free ${formatBytes(free)}…` : "Nothing to delete"}</button>
      </div>
    </div>
  );
}
