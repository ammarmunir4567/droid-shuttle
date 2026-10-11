import { open as pickDir } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo } from "react";
import { AlertTriangle, FolderOpen } from "lucide-react";
import { api, formatBytes, inTauri, type MediaItem, type Organize } from "../../lib/api";
import { plural } from "../../lib/paths";
import { Btn, Modal } from "../../components/Dialogs";
import { useGallery } from "../../store/gallery";
import { useUi } from "../../store/ui";

const ORGANIZE: { id: Organize; label: string; hint: string }[] = [
  { id: "month", label: "By month", hint: "2026/10/IMG_0001.jpg" },
  { id: "album", label: "By album", hint: "Camera/IMG_0001.jpg" },
  { id: "flat", label: "One folder", hint: "IMG_0001.jpg" },
];

export function ImportDialog({ items, serial }: { items: MediaItem[]; serial: string }) {
  const { importOpen, destDir, organize, deleteAfter, set, persist } = useGallery();
  useEffect(() => {
    if (importOpen && !destDir) void api.localHome().then((h) => persist({ destDir: `${h}/Pictures/Droid Shuttle` }));
  }, [importOpen, destDir, persist]);

  const total = useMemo(() => items.reduce((n, i) => n + i.size, 0), [items]);
  const already = items.filter((i) => i.imported).length;
  const close = () => set({ importOpen: false, deleteAfter: false });

  const start = async () => {
    close();
    try {
      await api.mediaImport({ serial, items: items.map((i) => ({ path: i.path, bucket: i.bucket, dateMs: i.dateMs })), destDir, organize, deleteAfter });
      set({ selection: [], anchor: null, lastImportDest: destDir });
      useUi.getState().toast({ kind: "info", text: `Importing ${plural(items.length, "item")} to ${destDir.split("/").pop()}…` }, 2500);
    } catch (e) {
      useUi.getState().toast({ kind: "error", text: `Couldn't start import: ${String(e)}` }, 6000);
    }
  };

  return (
    <Modal open={importOpen} onClose={close} title={`Import ${plural(items.length, "item")}`}>
      <p className="mb-3 text-[12px]" style={{ color: "var(--fg-muted)" }}>
        {formatBytes(total)} will be copied to your Mac.{already > 0 && ` ${already} ${already === 1 ? "was" : "were"} imported before — they'll be copied again.`}
      </p>

      <div className="mb-3">
        <div className="mb-1 text-[12px] font-medium " style={{ color: "var(--fg-muted)" }}>Save to</div>
        <div className="flex items-center gap-2 rounded-lg border px-2 py-1.5" style={{ borderColor: "var(--border)" }}>
          <FolderOpen size={15} className="shrink-0 text-[var(--color-accent)]" />
          <span className="min-w-0 flex-1 select-text truncate" title={destDir}>{destDir || "…"}</span>
          <button onClick={async () => { if (!inTauri) return; const d = await pickDir({ directory: true, defaultPath: destDir || undefined, title: "Import to" }); if (typeof d === "string") persist({ destDir: d }); }} className="rounded-md border px-2 py-0.5 text-[12px]" style={{ borderColor: "var(--border)" }}>Choose…</button>
        </div>
      </div>

      <div className="mb-3">
        <div className="mb-1 text-[12px] font-medium " style={{ color: "var(--fg-muted)" }}>Organize</div>
        <div role="radiogroup" className="grid grid-cols-3 gap-2">
          {ORGANIZE.map((o) => (
            <button key={o.id} role="radio" aria-checked={organize === o.id} onClick={() => persist({ organize: o.id })} className="rounded-lg border px-2 py-1.5 text-left" style={{ borderColor: organize === o.id ? "var(--color-accent)" : "var(--border)", background: organize === o.id ? "var(--selected)" : undefined }}>
              <div className="font-medium">{o.label}</div>
              <div className="truncate font-mono text-[10px]" style={{ color: "var(--fg-muted)" }}>{o.hint}</div>
            </button>
          ))}
        </div>
      </div>

      <label className="mb-1 flex cursor-default items-start gap-2 rounded-lg border p-2" style={{ borderColor: deleteAfter ? "var(--color-danger)" : "var(--border)" }}>
        <input type="checkbox" checked={deleteAfter} onChange={(e) => set({ deleteAfter: e.target.checked })} className="mt-0.5" />
        <span>
          <span className="font-medium">Delete from phone after importing</span>
          <span className="block text-[12px]" style={{ color: "var(--fg-muted)" }}>Each file is checked byte-for-byte (SHA-256) against its copy first, and only verified files are removed.</span>
        </span>
      </label>
      {deleteAfter && <p className="mb-1 flex items-center gap-1.5 text-[12px] text-[var(--color-danger)]"><AlertTriangle size={13} /> Android has no Trash over USB — removed photos can't be recovered from the phone.</p>}

      <div className="mt-4 flex justify-end gap-2">
        <Btn onClick={close}>Cancel</Btn>
        <Btn primary={!deleteAfter} danger={deleteAfter} autoFocus onClick={() => void start()}>{deleteAfter ? "Import and delete" : "Import"}</Btn>
      </div>
    </Modal>
  );
}
