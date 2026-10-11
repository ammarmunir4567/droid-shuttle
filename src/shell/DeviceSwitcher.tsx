import * as Dropdown from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { useDevices } from "../store/devices";

/** Wraps any trigger; when several phones are connected it opens a menu to pick one. */
export function DeviceSwitcher({ children, label = "Switch phone" }: { children: ReactNode; label?: string }) {
  const { devices, selected, select } = useDevices();
  if (devices.length < 2) return <>{children}</>;
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild aria-label={label}>{children}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="start" sideOffset={6} className="z-50 min-w-56 rounded-xl border p-1" style={{ background: "var(--panel)", borderColor: "var(--border)", boxShadow: "var(--shadow-pop)" }}>
          {devices.map((d) => (
            <Dropdown.Item key={d.serial} onSelect={() => select(d.serial)} className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-[var(--hover)]">
              <span className="size-2 rounded-full" style={{ background: d.serial === selected ? "var(--color-ok)" : "var(--border)" }} />
              <span className="flex-1">{d.model ?? d.serial}</span>
              <span className="text-[11px]" style={{ color: "var(--fg-muted)" }}>{d.wireless ? "Wi-Fi" : "USB"}</span>
            </Dropdown.Item>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
