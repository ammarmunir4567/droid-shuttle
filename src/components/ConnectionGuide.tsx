import { ShieldQuestion, AlertTriangle, Smartphone } from "lucide-react";
import type { ReactNode } from "react";
import { useDevices } from "../store/devices";
import { AppIcon } from "../brand/Logo";
import { BRAND } from "../brand/brand";

function Card({ icon, title, children, bare }: { icon: ReactNode; title: string; children: ReactNode; bare?: boolean }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
      {bare ? icon : <div className="grid size-16 place-items-center rounded-2xl" style={{ background: "var(--selected)", color: "var(--color-accent)" }}>{icon}</div>}
      <h1 className="text-[20px] font-semibold">{title}</h1>
      <div className="flex flex-col gap-2 text-[13px] leading-relaxed" style={{ color: "var(--fg-muted)" }}>{children}</div>
    </div>
  );
}

/** State-aware onboarding: tells the user exactly what to do next. */
export function ConnectionGuide() {
  const { devices, selected, adbError } = useDevices();
  const dev = devices.find((d) => d.serial === selected);

  if (adbError) {
    return (
      <Card icon={<AlertTriangle size={30} />} title="Can't reach the ADB service">
        <p>Droid Shuttle talks to your phone through Android platform-tools. Install them with:</p>
        <code className="rounded-md px-2 py-1 font-mono text-[12px]" style={{ background: "var(--hover)", userSelect: "text" }}>brew install --cask android-platform-tools</code>
        <p className="text-[12px]">{adbError}</p>
      </Card>
    );
  }
  if (dev?.state === "unauthorized") {
    return (
      <Card icon={<ShieldQuestion size={30} />} title="Allow this Mac on your phone">
        <p>Look at your phone's screen and tap <b>Allow</b> on the "Allow USB debugging?" prompt.</p>
        <p>Tick <b>Always allow from this computer</b> so you won't be asked again.</p>
      </Card>
    );
  }
  if (dev && dev.state !== "ready") {
    return (
      <Card icon={<AlertTriangle size={30} />} title={`Device is ${dev.state}`}>
        <p>Unplug and reconnect the cable, then unlock your phone.</p>
      </Card>
    );
  }
  return (
    <Card bare icon={<AppIcon size={84} />} title="Connect your Android phone">
      <p>Plug it in with a USB cable and unlock the screen.</p>
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-left">
        <li>Pull down the notification shade and tap <b>USB</b> → choose <b>File transfer</b>.</li>
        <li>For full access: <b>Settings → About phone</b>, tap <b>Build number</b> 7 times, then enable <b>USB debugging</b> in Developer options.</li>
      </ol>
      <div className="mt-2 flex items-center justify-center gap-2 text-[12px]"><Smartphone size={14} /> Waiting for a device…</div>
      <p className="text-[11px] opacity-70">{BRAND.tagline}</p>
    </Card>
  );
}
