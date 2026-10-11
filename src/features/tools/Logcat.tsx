import { save } from "@tauri-apps/plugin-dialog";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowDownToLine, Download, Pause, Play, Search, Trash2 } from "lucide-react";
import { api, inTauri } from "../../lib/api";
import { LEVELS, LEVEL_NAME, makeMatcher, parseLogcatLine, splitChunk, type Level, type LogLine } from "../../lib/logcat";
import { useUi } from "../../store/ui";

const MAX_LINES = 50_000;
const COLOR: Record<Level, string> = { V: "var(--fg-muted)", D: "oklch(0.62 0.15 250)", I: "oklch(0.62 0.16 150)", W: "oklch(0.7 0.16 75)", E: "oklch(0.62 0.22 25)", F: "oklch(0.62 0.22 25)" };

export function Logcat({ serial }: { serial: string }) {
  const [level, setLevel] = useState<Level>("V");
  const [tag, setTag] = useState("");
  const [text, setText] = useState("");
  const [pkg, setPkg] = useState("");
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [version, setVersion] = useState(0);
  const lines = useRef<LogLine[]>([]);
  const carry = useRef("");
  const nextId = useRef(1);
  const pausedRef = useRef(false);
  const held = useRef<LogLine[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  pausedRef.current = paused;

  const { data: pids } = useQuery({ queryKey: ["pids", serial, pkg], queryFn: () => api.pidsOfPackage(serial, pkg), enabled: !!pkg.trim(), refetchInterval: 4000 });
  const matcher = useMemo(() => makeMatcher({ level, tag, text, pids: pkg.trim() ? new Set(pids ?? []) : null }), [level, tag, text, pkg, pids]);
  const deferredVersion = useDeferredValue(version);
  const shown = useMemo(() => lines.current.filter(matcher), [matcher, deferredVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const ingest = useCallback((chunk: string) => {
    const s = splitChunk(carry.current, chunk);
    carry.current = s.carry;
    const parsed: LogLine[] = [];
    for (const raw of s.lines) { const l = parseLogcatLine(raw, nextId.current); if (l) { nextId.current++; parsed.push(l); } }
    if (!parsed.length) return;
    if (pausedRef.current) { held.current.push(...parsed); setVersion((v) => v + 1); return; }
    lines.current.push(...parsed);
    if (lines.current.length > MAX_LINES) lines.current.splice(0, lines.current.length - MAX_LINES);
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    // A (re)started stream replays the phone's recent buffer, so begin from an empty view.
    lines.current = []; held.current = []; carry.current = "";
    setVersion((v) => v + 1);
    void api.logcatStart(serial, false, ingest);
    return () => { void api.logcatStop(); };
  }, [serial, ingest]);

  const resume = () => { lines.current.push(...held.current); held.current = []; if (lines.current.length > MAX_LINES) lines.current.splice(0, lines.current.length - MAX_LINES); setPaused(false); setVersion((v) => v + 1); };
  const clear = async () => { lines.current = []; held.current = []; setVersion((v) => v + 1); await api.logcatClear(serial).catch(() => {}); };

  const virt = useVirtualizer({ count: shown.length, getScrollElement: () => scroller.current, estimateSize: () => 20, overscan: 30 });
  useEffect(() => { if (follow && shown.length) virt.scrollToIndex(shown.length - 1, { align: "end" }); }, [shown.length, follow]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportLog = async () => {
    const body = shown.map((l) => l.raw).join("\n");
    if (!inTauri) return void api.saveText("/tmp/logcat.txt", body);
    const path = await save({ defaultPath: "logcat.txt", title: "Export log" });
    if (path) { await api.saveText(path, body); useUi.getState().toast({ kind: "ok", text: `Saved ${shown.length.toLocaleString()} lines` }); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
        <select aria-label="Minimum level" value={level} onChange={(e) => setLevel(e.target.value as Level)} className="rounded-md border bg-transparent px-2 py-1" style={{ borderColor: "var(--border)" }}>
          {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_NAME[l]}{l === "V" ? " (all)" : " and up"}</option>)}
        </select>
        <input aria-label="Filter by tag" placeholder="Tag" value={tag} onChange={(e) => setTag(e.target.value)} className="w-32 rounded-md border bg-transparent px-2 py-1 outline-none" style={{ borderColor: "var(--border)" }} />
        <input aria-label="Filter by app package" placeholder="App package (com.example)" value={pkg} onChange={(e) => setPkg(e.target.value)} className="w-52 rounded-md border bg-transparent px-2 py-1 outline-none" style={{ borderColor: "var(--border)" }} />
        <label className="flex min-w-48 flex-1 items-center gap-1.5 rounded-md border px-2 py-1" style={{ borderColor: "var(--border)" }}>
          <Search size={13} style={{ color: "var(--fg-muted)" }} />
          <input aria-label="Search log" placeholder="Search — or /regex/" value={text} onChange={(e) => setText(e.target.value)} className="min-w-0 flex-1 bg-transparent outline-none" />
        </label>
        <button aria-label={paused ? "Resume" : "Pause"} title={paused ? "Resume" : "Pause"} onClick={() => (paused ? resume() : setPaused(true))} className={clsx("grid size-7 place-items-center rounded-md hover:bg-[var(--hover)]", paused && "bg-[var(--selected)] text-[var(--color-accent)]")}>{paused ? <Play size={14} /> : <Pause size={14} />}</button>
        <button aria-label="Follow new lines" aria-pressed={follow} title="Follow new lines" onClick={() => setFollow((f) => !f)} className={clsx("grid size-7 place-items-center rounded-md hover:bg-[var(--hover)]", follow && "bg-[var(--selected)] text-[var(--color-accent)]")}><ArrowDownToLine size={14} /></button>
        <button aria-label="Clear log" title="Clear" onClick={() => void clear()} className="grid size-7 place-items-center rounded-md hover:bg-[var(--hover)]"><Trash2 size={14} /></button>
        <button aria-label="Export log" title="Export shown lines" onClick={() => void exportLog()} className="grid size-7 place-items-center rounded-md hover:bg-[var(--hover)]"><Download size={14} /></button>
      </div>
      <div ref={scroller} role="log" aria-label="Log output" className="min-h-0 flex-1 overflow-auto font-mono text-[12px]" onScroll={(e) => { const el = e.currentTarget; const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40; if (!atBottom && follow) setFollow(false); }}>
        <div style={{ height: virt.getTotalSize(), position: "relative" }}>
          {virt.getVirtualItems().map((v) => {
            const l = shown[v.index];
            return (
              <div key={l.id} role="row" style={{ position: "absolute", top: 0, left: 0, width: "100%", height: v.size, transform: `translateY(${v.start}px)`, background: l.level === "F" ? "color-mix(in oklch, var(--color-danger) 14%, transparent)" : undefined }} className="flex select-text items-center gap-2 whitespace-nowrap px-3">
                <span className="shrink-0" style={{ color: "var(--fg-muted)" }}>{l.time.slice(6)}</span>
                <span className="w-24 shrink-0 truncate text-right" style={{ color: COLOR[l.level] }} title={l.tag}>{l.tag}</span>
                <span className="w-4 shrink-0 text-center font-semibold" style={{ color: COLOR[l.level] }}>{l.level}</span>
                <span className="truncate" style={{ color: l.level === "E" || l.level === "F" ? COLOR.E : undefined }}>{l.msg}</span>
              </div>
            );
          })}
        </div>
      </div>
      <footer className="flex h-7 shrink-0 items-center gap-3 border-t px-4 text-[11px]" style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}>
        <span>{shown.length.toLocaleString()} line{shown.length === 1 ? "" : "s"}{shown.length !== lines.current.length ? ` of ${lines.current.length.toLocaleString()}` : ""}</span>
        {paused && <span className="font-medium text-[var(--color-warn)]">Paused — {held.current.length.toLocaleString()} new line{held.current.length === 1 ? "" : "s"} waiting</span>}
        {pkg.trim() && <span>{pids && pids.length ? `showing PID ${pids.join(", ")}` : "app isn't running"}</span>}
      </footer>
    </div>
  );
}
