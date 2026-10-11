export type Level = "V" | "D" | "I" | "W" | "E" | "F";
export const LEVELS: Level[] = ["V", "D", "I", "W", "E", "F"];
export const LEVEL_NAME: Record<Level, string> = { V: "Verbose", D: "Debug", I: "Info", W: "Warning", E: "Error", F: "Fatal" };

export interface LogLine { id: number; time: string; pid: number; tid: number; level: Level; tag: string; msg: string; raw: string }

// `10-04 17:16:57.672  1234  5678 I ActivityManager: message`
const RE = /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.+?)\s*: ?(.*)$/;

export function parseLogcatLine(raw: string, id: number): LogLine | null {
  const m = RE.exec(raw.replace(/\r$/, ""));
  if (!m) return null;
  return { id, time: m[1], pid: Number(m[2]), tid: Number(m[3]), level: m[4] as Level, tag: m[5], msg: m[6], raw };
}

export interface LogFilter { level: Level; tag: string; text: string; pids: Set<number> | null }

/** `/regex/` filters by regular expression; anything else is a case-insensitive substring. */
export function compileText(text: string): ((s: string) => boolean) | null {
  const t = text.trim();
  if (!t) return null;
  if (t.length > 2 && t.startsWith("/") && t.endsWith("/")) {
    try { const re = new RegExp(t.slice(1, -1), "i"); return (s) => re.test(s); } catch { /* invalid regex: fall through to plain text */ }
  }
  const low = t.toLowerCase();
  return (s) => s.toLowerCase().includes(low);
}

export function makeMatcher(f: LogFilter): (l: LogLine) => boolean {
  const min = LEVELS.indexOf(f.level);
  const text = compileText(f.text);
  const tag = f.tag.trim().toLowerCase();
  return (l) =>
    LEVELS.indexOf(l.level) >= min &&
    (!tag || l.tag.toLowerCase().includes(tag)) &&
    (!f.pids || f.pids.has(l.pid)) &&
    (!text || text(`${l.tag} ${l.msg}`));
}

/** Parse a streamed chunk (which may end mid-line) → lines + the unfinished remainder. */
export function splitChunk(carry: string, chunk: string): { lines: string[]; carry: string } {
  const parts = (carry + chunk).split("\n");
  return { carry: parts.pop() ?? "", lines: parts };
}
