// Pointer-based drag & drop. We avoid HTML5 DnD so it never fights Tauri's native
// Finder-drop handling, and so we control spring-loaded folders, auto-scroll,
// modifier hints and the hand-off to a native drag when the cursor leaves the window.
import { useEffect } from "react";
import { create } from "zustand";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, inTauri, type FileEntry, type Side } from "./api";
import { baseName, isInside, parentPath } from "./paths";
import { currentSerial, importExternal, runOp } from "./ops";
import { useFiles } from "../store/files";
import { useUi } from "../store/ui";
import { useNav } from "../store/nav";
import { installFiles, isInstallable } from "./apps";

export interface DropTarget { side: Side; path: string; folderRow: boolean; label: string }
export const targetKey = (side: Side, path: string) => `${side}|${path}`;

interface DragStore {
  active: boolean;
  side: Side | null;
  items: FileEntry[];
  x: number;
  y: number;
  op: "copy" | "move";
  target: DropTarget | null;
  valid: boolean;
  /** Finder → app drag in progress. */
  external: { count: number } | null;
  externalTarget: DropTarget | null;
}

export const useDrag = create<DragStore>(() => ({
  active: false, side: null, items: [], x: 0, y: 0, op: "copy", target: null, valid: false, external: null, externalTarget: null,
}));

const SPRING_MS = 800;
const EDGE = 40;
let springTimer: ReturnType<typeof setTimeout> | null = null;
let springFor = "";
let raf = 0;

function hitTest(x: number, y: number): DropTarget | null {
  for (const n of document.elementsFromPoint(x, y)) {
    if (n instanceof HTMLElement && n.dataset.dropPath) {
      return { side: n.dataset.dropSide as Side, path: n.dataset.dropPath, folderRow: n.dataset.dropKind === "folder", label: n.dataset.dropLabel ?? baseName(n.dataset.dropPath) };
    }
  }
  return null;
}

function opFor(from: Side, to: Side, ev: { altKey: boolean; metaKey: boolean }): "copy" | "move" {
  return from === to ? (ev.altKey ? "copy" : "move") : ev.metaKey ? "move" : "copy";
}

function isValid(items: FileEntry[], from: Side, t: DropTarget | null, op: "copy" | "move") {
  if (!t) return false;
  if (items.some((i) => isInside(t.path, i.path) && t.side === from)) return false; // into itself
  if (from === t.side && op === "move" && items.every((i) => parentPath(i.path) === t.path)) return false; // no-op
  return true;
}

function updateSpring(t: DropTarget | null) {
  const key = t?.folderRow ? targetKey(t.side, t.path) : "";
  if (key === springFor) return;
  springFor = key;
  if (springTimer) clearTimeout(springTimer);
  springTimer = null;
  if (t?.folderRow) springTimer = setTimeout(() => useFiles.getState().navigate(t.side, t.path), SPRING_MS);
}

function autoScroll() {
  const { active, x, y } = useDrag.getState();
  if (!active) return;
  const sc = document.elementsFromPoint(x, y).find((n) => n instanceof HTMLElement && n.dataset.scroll !== undefined) as HTMLElement | undefined;
  if (sc) {
    const r = sc.getBoundingClientRect();
    if (y < r.top + EDGE) sc.scrollTop -= Math.ceil((r.top + EDGE - y) / 3);
    else if (y > r.bottom - EDGE) sc.scrollTop += Math.ceil((y - (r.bottom - EDGE)) / 3);
  }
  raf = requestAnimationFrame(autoScroll);
}

function end() {
  if (springTimer) clearTimeout(springTimer);
  springTimer = null; springFor = "";
  cancelAnimationFrame(raf);
  document.body.style.cursor = "";
  useDrag.setState({ active: false, side: null, items: [], target: null, valid: false });
}

/** Attach to a row's onPointerDown. Starts a drag after a 5px threshold. */
export function onRowPointerDown(e: React.PointerEvent, side: Side, entry: FileEntry) {
  if ((e.target as HTMLElement).closest("input")) return;
  if (e.button === 2) {
    // Right-click selects the row under the cursor first, like Finder.
    const f = useFiles.getState();
    if (!f.panes[side].selection.includes(entry.path)) f.select(side, [entry.path], entry.path);
    return;
  }
  if (e.button !== 0) return;
  const [sx, sy] = [e.clientX, e.clientY];
  let started = false;

  const begin = () => {
    const f = useFiles.getState();
    if (!f.panes[side].selection.includes(entry.path)) f.select(side, [entry.path], entry.path);
    const sel = new Set(useFiles.getState().panes[side].selection);
    const items = f.entries[side].filter((x) => sel.has(x.path));
    if (!items.length) return false;
    useDrag.setState({ active: true, side, items, x: sx, y: sy });
    document.body.style.cursor = "grabbing";
    raf = requestAnimationFrame(autoScroll);
    return true;
  };

  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      started = begin();
      if (!started) return cleanup();
    }
    const { items } = useDrag.getState();
    // Cursor left the window → hand the drag to macOS so Finder / other apps can receive it.
    if (inTauri && (ev.clientX < 0 || ev.clientY < 0 || ev.clientX > window.innerWidth || ev.clientY > window.innerHeight)) {
      end(); cleanup();
      api.nativeDrag(side === "device" ? currentSerial() : null, items.map((i) => ({ path: i.path, isDir: i.isDir })))
        .catch((e) => useUi.getState().toast({ kind: "error", text: `Couldn't drag to Finder: ${String(e)}. Use “Save to Mac…” instead.` }, 7000));
      return;
    }
    const target = hitTest(ev.clientX, ev.clientY);
    const op = target ? opFor(side, target.side, ev) : "copy";
    const valid = isValid(items, side, target, op);
    updateSpring(valid ? target : null);
    useDrag.setState({ x: ev.clientX, y: ev.clientY, op, target: valid ? target : null, valid });
  };

  const up = (ev: PointerEvent) => {
    cleanup();
    if (!started) return;
    const { items, target, valid, op } = useDrag.getState();
    end();
    if (valid && target) void runOp({ from: side, to: target.side, paths: items.map((i) => i.path), destDir: target.path, op });
    ev.preventDefault();
  };
  const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { end(); cleanup(); } };
  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", key);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", key);
}

/** Finder → app drops, via Tauri's native drag-drop events. */
export function useExternalDrops() {
  useEffect(() => {
    if (!inTauri) return;
    let un: (() => void) | undefined;
    const fallbackTarget = (): DropTarget => {
      const f = useFiles.getState();
      const side: Side = f.dual && f.active === "local" ? "local" : "device";
      return { side, path: f.panes[side].path, folderRow: false, label: baseName(f.panes[side].path) };
    };
    getCurrentWebview().onDragDropEvent((ev) => {
      const p = ev.payload;
      if (p.type === "leave") return useDrag.setState({ external: null, externalTarget: null });
      const at = () => hitTest(p.position.x / window.devicePixelRatio, p.position.y / window.devicePixelRatio) ?? fallbackTarget();
      if (p.type === "enter") useDrag.setState({ external: { count: p.paths.length }, externalTarget: at() });
      else if (p.type === "over") useDrag.setState({ externalTarget: at() });
      else if (p.type === "drop") {
        const t = at();
        useDrag.setState({ external: null, externalTarget: null });
        if (useNav.getState().section === "apps") {
          const apps = p.paths.filter(isInstallable);
          if (apps.length) void installFiles(apps);
          else useUi.getState().toast({ kind: "info", text: "Drop .apk, .xapk, .apks or .apkm files here to install them" });
          return;
        }
        void importExternal(p.paths, { side: t.side, path: t.path });
      }
    }).then((f) => (un = f));
    return () => un?.();
  }, []);
}
