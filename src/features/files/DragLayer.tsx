import { createPortal } from "react-dom";
import { Copy, MoveRight, UploadCloud } from "lucide-react";
import { kindOf } from "../../lib/fileKind";
import { useDrag } from "../../lib/drag";
import { useDevices } from "../../store/devices";
import { useNav } from "../../store/nav";

/** Drag ghost (count badge + live Copy/Move hint) and the Finder-drop overlay. */
export function DragLayer() {
  const { active, items, x, y, op, target, valid, external, externalTarget } = useDrag();
  const dev = useDevices((s) => s.devices.find((d) => d.serial === s.selected));
  const onApps = useNav((s) => s.section === "apps");
  const first = items[0];
  const Icon = first ? kindOf(first.name, first.isDir).icon : null;
  return createPortal(
    <>
      {external && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center" style={{ background: "color-mix(in oklch, var(--color-accent) 12%, transparent)", boxShadow: "inset 0 0 0 3px var(--color-accent)" }}>
          <div className="flex flex-col items-center gap-2 rounded-2xl border px-8 py-6 shadow-2xl" style={{ background: "var(--bg-solid)", borderColor: "var(--border)" }}>
            <UploadCloud size={38} className="text-[var(--color-accent)]" />
            {onApps ? (
              <>
                <div className="text-[15px] font-semibold">Drop to install on {dev?.model ?? "your phone"}</div>
                <div className="text-[11px]" style={{ color: "var(--fg-muted)" }}>.apk, .xapk, .apks and .apkm files</div>
              </>
            ) : (
              <>
                <div className="text-[15px] font-semibold">Drop to copy {external.count} item{external.count > 1 ? "s" : ""}</div>
                <div style={{ color: "var(--fg-muted)" }}>to {externalTarget?.side === "local" ? "Mac" : dev?.model ?? "phone"} › {externalTarget?.label ?? "…"}</div>
                <div className="text-[11px]" style={{ color: "var(--fg-muted)" }}>App files can be installed instead</div>
              </>
            )}
          </div>
        </div>
      )}
      {active && Icon && (
        <div className="pointer-events-none fixed z-50" style={{ left: x + 14, top: y + 14 }}>
          <div className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 shadow-xl" style={{ background: "var(--bg-solid)", borderColor: valid ? "var(--color-accent)" : "var(--border)" }}>
            <span className="relative"><Icon size={18} />
              {items.length > 1 && <span className="absolute -right-3 -top-2.5 grid min-w-4 place-items-center rounded-full bg-[var(--color-accent)] px-1 text-[10px] font-semibold text-[var(--accent-ink)]">{items.length}</span>}
            </span>
            <span className="max-w-44 truncate pl-1">{items.length > 1 ? `${items.length} items` : first.name}</span>
            {valid && target && (
              <span className="flex items-center gap-1 border-l pl-2 text-[11px] font-medium text-[var(--color-accent)]" style={{ borderColor: "var(--border)" }}>
                {op === "move" ? <MoveRight size={12} /> : <Copy size={12} />}{op === "move" ? "Move" : "Copy"} to {target.label}
              </span>
            )}
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
