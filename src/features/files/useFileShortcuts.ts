import { useEffect } from "react";
import { copySelection, duplicateSelection, pasteInto, selectAll } from "../../lib/clipboard";
import { deleteInActivePane, newFolderInActivePane, transferToOtherPane } from "../../lib/dual";
import { useFiles } from "../../store/files";

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
};
const dialogOpen = () => !!document.querySelector('[role="dialog"]');

/**
 * Window-level file shortcuts, so they work whether or not the list has keyboard focus.
 * Handles both raw key presses and the `copy`/`cut`/`paste` events macOS menus can produce
 * (guarded so one press never runs twice).
 */
export function useFileShortcuts() {
  useEffect(() => {
    let lastKeyAt = 0;
    const side = () => useFiles.getState().active;
    const fresh = () => Date.now() - lastKeyAt > 250;

    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || dialogOpen()) return;
      const f = useFiles.getState();
      if (f.dual && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const act = { F5: () => transferToOtherPane("copy"), F6: () => transferToOtherPane("move"), F7: newFolderInActivePane, F8: deleteInActivePane }[e.key];
        if (act) { e.preventDefault(); void act(); return; }
      }
      if (f.dual && e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "u") { e.preventDefault(); f.swapPanes(); return; }
      if (!(e.metaKey || e.ctrlKey) || typing(e.target) || dialogOpen()) return;
      const k = e.key.toLowerCase();
      const run = (fn: () => void) => { e.preventDefault(); lastKeyAt = Date.now(); fn(); };
      if (k === "c" && !e.shiftKey) run(() => void copySelection(side(), false));
      else if (k === "x") run(() => void copySelection(side(), true));
      else if (k === "v") run(() => void pasteInto(side(), e.altKey));
      else if (k === "d" && !e.shiftKey) run(() => void duplicateSelection(side()));
      else if (k === "a") run(() => selectAll(side()));
    };

    const onClip = (kind: "copy" | "cut" | "paste") => (e: ClipboardEvent) => {
      if (typing(e.target) || dialogOpen() || !fresh()) return;
      e.preventDefault();
      if (kind === "paste") void pasteInto(side());
      else void copySelection(side(), kind === "cut");
    };
    const [onCopy, onCut, onPaste] = [onClip("copy"), onClip("cut"), onClip("paste")];

    window.addEventListener("keydown", onKey, true);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
    };
  }, []);
}
