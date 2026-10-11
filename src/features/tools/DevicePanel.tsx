import { useQuery } from "@tanstack/react-query";
import { BatteryCharging, Cpu, HardDrive, MemoryStick, Smartphone, Wifi } from "lucide-react";
import { api, formatBytes } from "../../lib/api";

function Bar({ pct, warn }: { pct: number; warn?: boolean }) {
  return <div className="h-2 overflow-hidden rounded-full" style={{ background: "var(--border)" }}><div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: warn ? "var(--color-danger)" : "var(--color-accent)" }} /></div>;
}
const uptime = (s: number) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };

export function DevicePanel({ serial }: { serial: string }) {
  const { data: d, error } = useQuery({ queryKey: ["status", serial], queryFn: () => api.deviceStatus(serial), refetchInterval: 5000 });
  if (error) return <div className="grid h-full place-items-center" style={{ color: "var(--fg-muted)" }}>Couldn't read the phone's status: {String(error)}</div>;
  if (!d) return <div className="grid h-full place-items-center" style={{ color: "var(--fg-muted)" }}>Reading status…</div>;
  const memUsed = d.memTotal - d.memAvailable;
  const card = "rounded-xl border p-4";
  const Row = ({ k, v }: { k: string; v: string }) => (<><dt style={{ color: "var(--fg-muted)" }}>{k}</dt><dd className="select-text truncate" title={v}>{v || "—"}</dd></>);
  return (
    <div className="h-full overflow-auto p-5">
      <div className="mx-auto grid max-w-3xl grid-cols-2 gap-4">
        <section className={card} style={{ borderColor: "var(--border)" }} aria-label="Battery">
          <h2 className="mb-2 flex items-center gap-2 font-semibold"><BatteryCharging size={16} className="text-[var(--color-accent)]" /> Battery</h2>
          <div className="mb-1 text-[28px] font-semibold tabular-nums">{d.batteryLevel ?? "—"}%</div>
          <Bar pct={d.batteryLevel ?? 0} warn={(d.batteryLevel ?? 100) <= 15} />
          <dl className="mt-3 grid grid-cols-[90px_1fr] gap-y-1 text-[12px]">
            <Row k="Status" v={d.batteryStatus} /><Row k="Power" v={d.plugged} /><Row k="Health" v={d.batteryHealth} />
            <Row k="Temperature" v={d.batteryTempC != null ? `${d.batteryTempC.toFixed(1)} °C` : ""} /><Row k="Voltage" v={d.batteryVoltageMv ? `${(d.batteryVoltageMv / 1000).toFixed(2)} V` : ""} />
          </dl>
        </section>
        <section className={card} style={{ borderColor: "var(--border)" }} aria-label="Memory and storage">
          <h2 className="mb-2 flex items-center gap-2 font-semibold"><MemoryStick size={16} className="text-[var(--color-accent)]" /> Memory</h2>
          <div className="mb-1 text-[12px]">{formatBytes(memUsed)} used of {formatBytes(d.memTotal)}</div>
          <Bar pct={(memUsed / d.memTotal) * 100} warn={memUsed / d.memTotal > 0.9} />
          <h2 className="mb-2 mt-4 flex items-center gap-2 font-semibold"><HardDrive size={16} className="text-[var(--color-accent)]" /> Storage</h2>
          <div className="mb-1 text-[12px]">{formatBytes(d.storageUsed)} used · {formatBytes(d.storageTotal - d.storageUsed)} free of {formatBytes(d.storageTotal)}</div>
          <Bar pct={(d.storageUsed / d.storageTotal) * 100} warn={d.storageUsed / d.storageTotal > 0.9} />
        </section>
        <section className={card + " col-span-2"} style={{ borderColor: "var(--border)" }} aria-label="Device details">
          <h2 className="mb-2 flex items-center gap-2 font-semibold"><Smartphone size={16} className="text-[var(--color-accent)]" /> Device</h2>
          <dl className="grid grid-cols-[110px_1fr_110px_1fr] gap-x-4 gap-y-1 text-[12px]">
            <Row k="Model" v={`${d.manufacturer} ${d.model}`} /><Row k="Android" v={`${d.android} (API ${d.sdk})`} />
            <Row k="Security patch" v={d.securityPatch} /><Row k="Build" v={d.build} />
            <Row k="Processor" v={d.abi} /><Row k="Kernel" v={d.kernel} />
            <Row k="Screen" v={`${d.screen} @ ${d.density} dpi`} /><Row k="Uptime" v={uptime(d.uptimeSecs)} />
          </dl>
          <p className="mt-3 flex items-center gap-2 text-[12px]" style={{ color: "var(--fg-muted)" }}>{d.wifiIp ? <><Wifi size={13} /> Wi-Fi address {d.wifiIp}</> : <><Wifi size={13} /> Not connected to Wi-Fi</>} <Cpu size={13} className="ml-3" /> Updates every 5 seconds</p>
        </section>
      </div>
    </div>
  );
}
