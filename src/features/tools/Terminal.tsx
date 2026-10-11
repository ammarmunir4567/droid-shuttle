import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { RotateCcw } from "lucide-react";
import { api } from "../../lib/api";

const dark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;

/** A real terminal on the phone: adb shell with a pty, so vim, top, tab-completion and colours work. */
export function Terminal({ serial }: { serial: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [exited, setExited] = useState<number | null>(null);
  const [session, setSession] = useState(0); // bump to restart

  useEffect(() => {
    const el = host.current!;
    setExited(null);
    const term = new XTerm({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: 13, cursorBlink: true, scrollback: 5000, allowProposedApi: true,
      theme: dark() ? { background: "#1b1b1d", foreground: "#e8e8e8" } : { background: "#ffffff", foreground: "#1d1d1f", cursor: "#1d1d1f", selectionBackground: "#bcd7ff" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    let id: number | null = null;
    let closed = false;
    const enc = new TextEncoder();
    term.onData((d) => { if (id !== null) void api.shellWrite(id, enc.encode(d)); });
    void api
      .shellStart(serial, term.cols, term.rows, (buf) => {
        const u8 = new Uint8Array(buf);
        if (u8[0] === 1 || u8[0] === 2) term.write(u8.subarray(1));
        else if (u8[0] === 3) { term.write(`\r\n\x1b[2m[shell exited with code ${u8[1]}]\x1b[0m\r\n`); setExited(u8[1]); }
      })
      .then((sid) => { if (closed) void api.shellClose(sid); else id = sid; })
      .catch((e) => term.write(`\r\n\x1b[31mCouldn't open a shell: ${String(e)}\x1b[0m\r\n`));
    const ro = new ResizeObserver(() => { fit.fit(); if (id !== null) void api.shellResize(id, term.cols, term.rows); });
    ro.observe(el);
    term.focus();
    return () => { closed = true; ro.disconnect(); if (id !== null) void api.shellClose(id); term.dispose(); };
  }, [serial, session]);

  return (
    <div className="flex h-full flex-col">
      {exited !== null && (
        <div className="flex items-center gap-3 border-b px-4 py-1.5 text-[12px]" style={{ borderColor: "var(--border)" }}>
          <span style={{ color: "var(--fg-muted)" }}>The shell ended.</span>
          <button onClick={() => setSession((n) => n + 1)} className="flex items-center gap-1 text-[var(--color-accent)]"><RotateCcw size={12} /> New shell</button>
        </div>
      )}
      <div ref={host} aria-label="Terminal" className="min-h-0 flex-1 p-2" style={{ background: dark() ? "#1b1b1d" : "#fff" }} />
    </div>
  );
}
