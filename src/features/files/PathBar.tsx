import clsx from "clsx";
import { ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";
import { targetKey, useDrag } from "../../lib/drag";
import { baseName, parentPath } from "../../lib/paths";
import { useFiles } from "../../store/files";
import type { Side } from "../../lib/api";

export function Btn({ children, label, onClick, disabled, on }: { children: ReactNode; label: string; onClick: () => void; disabled?: boolean; on?: boolean }) {
  return (
    <button aria-label={label} title={label} disabled={disabled} onClick={onClick} className={clsx("grid size-7 shrink-0 place-items-center rounded-md hover:bg-[var(--hover)] disabled:opacity-30", on && "bg-[var(--selected)] text-[var(--color-accent)]")}>
      {children}
    </button>
  );
}

export function crumbs(side: Side, path: string, home: string) {
  const out: { label: string; path: string }[] = [];
  let base = "";
  let rest = path;
  if (side === "device" && path.startsWith("/sdcard")) { out.push({ label: "Internal storage", path: "/sdcard" }); base = "/sdcard"; rest = path.slice(7); }
  else if (side === "local" && home && path.startsWith(home)) { out.push({ label: baseName(home) || "Home", path: home }); base = home; rest = path.slice(home.length); }
  else out.push({ label: side === "device" ? "Device" : "Macintosh HD", path: "/" });
  for (const seg of rest.split("/").filter(Boolean)) { base = `${base}/${seg}`; out.push({ label: seg, path: base }); }
  return out;
}

/** Back / forward / enclosing folder plus a clickable path, for one pane. Folders can be dropped on the path segments. */
export function PathBar({ side, home }: { side: Side; home: string }) {
  const pane = useFiles((s) => s.panes[side]);
  const { navigate, goBack, goForward } = useFiles.getState();
  const dragKey = useDrag((s) => (s.target ? targetKey(s.target.side, s.target.path) : s.externalTarget ? targetKey(s.externalTarget.side, s.externalTarget.path) : ""));
  const list = crumbs(side, pane.path, home);
  const name = side === "device" ? "Phone" : "Mac";
  return (
    <>
      <Btn label={`Back (⌘[)${side === "local" ? " in Mac pane" : ""}`} onClick={() => goBack(side)} disabled={!pane.back.length}><ChevronLeft size={16} /></Btn>
      <Btn label="Forward (⌘])" onClick={() => goForward(side)} disabled={!pane.forward.length}><ChevronRight size={16} /></Btn>
      <Btn label="Enclosing folder (⌘↑)" onClick={() => navigate(side, parentPath(pane.path))} disabled={pane.path === "/" || !pane.path}><ChevronUp size={16} /></Btn>
      <nav aria-label={`${name} path`} className="ml-2 flex min-w-0 items-center overflow-hidden text-[13px]">
        {list.map((c, i) => (
          <span key={c.path} className="flex items-center">
            {i > 0 && <ChevronRight size={12} style={{ color: "var(--fg-muted)" }} />}
            <button
              data-drop-side={side} data-drop-path={c.path} data-drop-kind="crumb"
              onClick={() => navigate(side, c.path)}
              className={clsx("max-w-40 truncate rounded px-1.5 py-0.5 hover:bg-[var(--hover)]", i === list.length - 1 && "font-semibold", dragKey === targetKey(side, c.path) && "bg-[var(--selected)] ring-1 ring-[var(--color-accent)]")}
            >{c.label}</button>
          </span>
        ))}
      </nav>
    </>
  );
}
