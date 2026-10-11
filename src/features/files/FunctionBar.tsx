import { ArrowLeftRight, Copy, FolderPlus, MoveRight, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { deleteInActivePane, newFolderInActivePane, transferToOtherPane } from "../../lib/dual";
import { useFiles } from "../../store/files";

function Key({ k, label, hint, onClick, disabled, children, danger }: { k: string; label: string; hint?: string; onClick: () => void; disabled?: boolean; children: ReactNode; danger?: boolean }) {
  return (
    <button
      aria-label={label} title={hint ?? label} disabled={disabled} onClick={onClick}
      className="flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] hover:bg-[var(--hover)] disabled:opacity-40"
      style={{ borderColor: "var(--border)", color: danger ? "var(--color-danger)" : undefined }}
    >
      <kbd className="font-sans text-[10.5px] opacity-60">{k}</kbd>{children}<span>{label}</span>
    </button>
  );
}

/** Commander-style action bar: F-keys act on the active pane and send to the other one. */
export function FunctionBar() {
  const active = useFiles((s) => s.active);
  const count = useFiles((s) => s.panes[s.active].selection.length);
  const swapPanes = useFiles((s) => s.swapPanes);
  const to = active === "device" ? "Mac" : "phone";
  const none = count === 0;
  return (
    <div role="toolbar" aria-label="Two-pane actions" className="flex h-10 shrink-0 items-center gap-1.5 border-t px-3" style={{ borderColor: "var(--border)" }}>
      <Key k="F5" label={`Copy to ${to}`} hint={`Copy the selection to the ${to} pane (F5)`} disabled={none} onClick={() => void transferToOtherPane("copy")}><Copy size={13} /></Key>
      <Key k="F6" label={`Move to ${to}`} hint={`Move the selection to the ${to} pane (F6)`} disabled={none} onClick={() => void transferToOtherPane("move")}><MoveRight size={13} /></Key>
      <Key k="F7" label="New folder" onClick={() => void newFolderInActivePane()}><FolderPlus size={13} /></Key>
      <Key k="F8" label="Delete" disabled={none} danger onClick={() => void deleteInActivePane()}><Trash2 size={13} /></Key>
      <span className="mx-1 h-4 w-px" style={{ background: "var(--border)" }} />
      <Key k="⌘U" label="Swap panes" onClick={swapPanes}><ArrowLeftRight size={13} /></Key>
      <span className="ml-auto text-[11px]" style={{ color: "var(--fg-muted)" }}>Tab switches panes{count ? ` · ${count} selected` : ""}</span>
    </div>
  );
}
