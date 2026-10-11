import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useUi } from "../store/ui";

export function Toaster() {
  const { toasts, dismiss } = useUi();
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-14 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const Icon = t.kind === "ok" ? CheckCircle2 : t.kind === "error" ? AlertCircle : Info;
        return (
          <div key={t.id} className="pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 shadow-xl" style={{ background: "var(--bg-solid)", borderColor: "var(--border)" }}>
            <Icon size={16} className="mt-0.5 shrink-0" style={{ color: t.kind === "ok" ? "var(--color-ok)" : t.kind === "error" ? "var(--color-danger)" : "var(--color-accent)" }} />
            <span className="min-w-0 flex-1 break-words">{t.text}</span>
            {t.action && <button onClick={() => { t.action!.run(); dismiss(t.id); }} className="font-medium text-[var(--color-accent)]">{t.action.label}</button>}
            <button aria-label="Dismiss" onClick={() => dismiss(t.id)}><X size={13} /></button>
          </div>
        );
      })}
    </div>
  );
}
