import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState, type ReactNode } from "react";
import { baseName } from "../lib/paths";
import { useUi } from "../store/ui";

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/3 z-50 w-[440px] -translate-x-1/2 rounded-xl border p-5 shadow-2xl outline-none" style={{ background: "var(--bg-solid)", borderColor: "var(--border)" }}>
          <Dialog.Title className="mb-1 text-[15px] font-semibold">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const Btn = ({ children, onClick, primary, danger, autoFocus }: { children: ReactNode; onClick: () => void; primary?: boolean; danger?: boolean; autoFocus?: boolean }) => (
  <button autoFocus={autoFocus} onClick={onClick} className="rounded-md border px-3 py-1.5 font-medium" style={primary || danger ? { background: danger ? "var(--color-danger)" : "var(--color-accent)", color: "var(--accent-ink)", borderColor: "transparent" } : { borderColor: "var(--border)" }}>{children}</button>
);

export function Dialogs() {
  const { confirm, conflict, apk, close } = useUi();
  const [checked, setChecked] = useState(false);
  useEffect(() => setChecked(false), [confirm]);
  return (
    <>
      <Modal open={!!confirm} onClose={() => { confirm?.resolve(false, false); close("confirm"); }} title={confirm?.title ?? ""}>
        <p className="mb-4" style={{ color: "var(--fg-muted)" }}>{confirm?.body}</p>
        {confirm?.option && <label className="mb-4 flex cursor-default items-center gap-2"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />{confirm.option}</label>}
        <div className="flex justify-end gap-2">
          <Btn autoFocus onClick={() => { confirm?.resolve(false, false); close("confirm"); }}>Cancel</Btn>
          <Btn danger={confirm?.danger} primary={!confirm?.danger} onClick={() => { confirm?.resolve(true, checked); close("confirm"); }}>{confirm?.confirmLabel}</Btn>
        </div>
      </Modal>

      <Modal open={!!conflict} onClose={() => { conflict?.resolve(null); close("conflict"); }} title={conflict ? (conflict.names.length === 1 ? `“${conflict.names[0]}” already exists` : `${conflict.names.length} items already exist`) : ""}>
        <p className="mb-1" style={{ color: "var(--fg-muted)" }}>in “{conflict?.destLabel}”. What would you like to do?</p>
        {conflict && conflict.names.length > 1 && <p className="mb-3 max-h-16 overflow-auto text-[12px]" style={{ color: "var(--fg-muted)" }}>{conflict.names.slice(0, 8).join(", ")}{conflict.names.length > 8 ? "…" : ""}</p>}
        <p className="mb-4 text-[11px]" style={{ color: "var(--fg-muted)" }}>Replace overwrites files; same-named folders are merged.</p>
        <div className="flex justify-end gap-2">
          <Btn onClick={() => { conflict?.resolve(null); close("conflict"); }}>Cancel</Btn>
          <Btn onClick={() => { conflict?.resolve("skip"); close("conflict"); }}>Skip</Btn>
          <Btn onClick={() => { conflict?.resolve("replace"); close("conflict"); }}>Replace</Btn>
          <Btn primary autoFocus onClick={() => { conflict?.resolve("keepBoth"); close("conflict"); }}>Keep both</Btn>
        </div>
      </Modal>

      <Modal open={!!apk} onClose={() => { apk?.resolve(null); close("apk"); }} title={apk ? (apk.paths.length === 1 ? `Install “${baseName(apk.paths[0])}”?` : `Install ${apk.paths.length} apps?`) : ""}>
        <p className="mb-4" style={{ color: "var(--fg-muted)" }}>You dropped an Android app package. Install it on your phone, or just copy the file.</p>
        <div className="flex justify-end gap-2">
          <Btn onClick={() => { apk?.resolve(null); close("apk"); }}>Cancel</Btn>
          <Btn onClick={() => { apk?.resolve("copy"); close("apk"); }}>Copy file only</Btn>
          <Btn primary autoFocus onClick={() => { apk?.resolve("install"); close("apk"); }}>Install</Btn>
        </div>
      </Modal>
    </>
  );
}
