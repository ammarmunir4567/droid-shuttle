import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Loader2, QrCode, Unplug, Usb, Wifi, X } from "lucide-react";
import { api } from "../../lib/api";
import { useDevices } from "../../store/devices";
import { useUi } from "../../store/ui";

const toast = (kind: "info" | "ok" | "error", text: string, ms = 6000) => useUi.getState().toast({ kind, text }, ms);
const card = "rounded-xl border p-4";
const input = "rounded-md border bg-transparent px-2 py-1.5 outline-none";
const HOSTPORT = /^[\w.-]+:\d{2,5}$/;

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className={card} style={{ borderColor: "var(--border)" }} aria-label={title}>
      <h2 className="font-semibold">{title}</h2>
      {hint && <p className="mb-3 text-[12px]" style={{ color: "var(--fg-muted)" }}>{hint}</p>}
      {children}
    </section>
  );
}

export function Wireless({ serial }: { serial: string }) {
  const devices = useDevices((s) => s.devices);
  const usb = devices.find((d) => d.serial === serial && !d.wireless);
  const [busy, setBusy] = useState<string | null>(null);
  const [pairAddr, setPairAddr] = useState("");
  const [code, setCode] = useState("");
  const [connectAddr, setConnectAddr] = useState("");
  const [qr, setQr] = useState<{ name: string; password: string } | null>(null);
  const qrCanvas = useRef<HTMLCanvasElement>(null);
  const cancelled = useRef(false);

  const { data: status } = useQuery({ queryKey: ["status", serial], queryFn: () => api.deviceStatus(serial), enabled: !!usb });
  const { data: found = [] } = useQuery({ queryKey: ["mdns"], queryFn: () => api.wifiMdns(), refetchInterval: 3000 });
  const wireless = devices.filter((d) => d.wireless);

  const run = async (key: string, fn: () => Promise<string | void>, ok: (r: string) => string) => {
    setBusy(key);
    try { const r = await fn(); toast("ok", ok(String(r ?? ""))); } catch (e) { toast("error", String(e), 9000); } finally { setBusy(null); }
  };

  const startQr = async () => {
    cancelled.current = false;
    const info = await api.wifiQr();
    setQr(info);
    setTimeout(() => qrCanvas.current && void QRCode.toCanvas(qrCanvas.current, info.payload, { width: 220, margin: 1 }), 0);
    try {
      const addr = await api.wifiQrFinish(info.name, info.password, 120);
      if (!cancelled.current) toast("ok", `Paired and connected — ${addr}`);
    } catch (e) { if (!cancelled.current) toast("error", String(e), 10000); }
    setQr(null);
  };
  useEffect(() => () => { cancelled.current = true; }, []);

  return (
    <div className="h-full overflow-auto p-5">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {wireless.length > 0 && (
          <Section title="Connected wirelessly">
            <ul className="flex flex-col gap-1">
              {wireless.map((d) => (
                <li key={d.serial} className="flex items-center gap-2 text-[13px]"><Wifi size={14} className="text-[var(--color-ok)]" /><span className="flex-1 select-text">{d.model ?? "Android"} · {d.serial}</span>
                  <button onClick={() => void run(`dc-${d.serial}`, () => api.wifiDisconnect(d.serial), () => `Disconnected ${d.serial}`)} className="flex items-center gap-1 rounded-md border px-2 py-1 text-[12px]" style={{ borderColor: "var(--border)" }}><Unplug size={12} /> Disconnect</button></li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="Switch to wireless (cable plugged in)" hint="Works on any Android phone. The phone and this Mac must be on the same Wi-Fi network. After it connects you can unplug the cable.">
          <div className="flex items-center gap-3">
            <Usb size={16} className="text-[var(--color-accent)]" />
            <span className="flex-1 text-[13px]">{!usb ? "Plug the phone in with a USB cable to use this." : status?.wifiIp ? `Phone's Wi-Fi address: ${status.wifiIp}` : status ? "The phone isn't on Wi-Fi yet." : "Checking Wi-Fi…"}</span>
            <button disabled={!usb || !status?.wifiIp || !!busy} onClick={() => void run("go", () => api.wifiGoWireless(serial), (a) => `Connected to ${a} — you can unplug the cable`)} className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 font-medium text-[var(--accent-ink)] disabled:opacity-40">{busy === "go" && <Loader2 size={13} className="animate-spin" />} Go wireless</button>
          </div>
        </Section>

        <Section title="Pair with a QR code (Android 11+)" hint="On the phone: Settings → Developer options → Wireless debugging → Pair device with QR code, then scan this.">
          {qr ? (
            <div className="flex items-center gap-5">
              <canvas ref={qrCanvas} aria-label="Pairing QR code" className="rounded-lg bg-white p-1" width={220} height={220} />
              <div className="flex-1 text-[13px]"><p className="mb-2 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Waiting for the phone to scan…</p><p className="text-[12px]" style={{ color: "var(--fg-muted)" }}>Keep the phone's QR scanner open. This code works once and expires in 2 minutes.</p>
                <button onClick={() => { cancelled.current = true; setQr(null); }} className="mt-3 flex items-center gap-1 text-[12px] text-[var(--color-accent)]"><X size={12} /> Cancel</button></div>
            </div>
          ) : <button onClick={() => void startQr()} className="flex items-center gap-1.5 rounded-md border px-3 py-1.5" style={{ borderColor: "var(--border)" }}><QrCode size={14} /> Show QR code</button>}
        </Section>

        <Section title="Pair with a pairing code (Android 11+)" hint="On the phone: Wireless debugging → Pair device with pairing code. Enter the address and 6-digit code it shows.">
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label="Pairing address" placeholder="192.168.1.37:41201" value={pairAddr} onChange={(e) => setPairAddr(e.target.value)} className={input + " w-52"} style={{ borderColor: "var(--border)" }} />
            <input aria-label="Pairing code" placeholder="123456" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} className={input + " w-28"} style={{ borderColor: "var(--border)" }} />
            <button disabled={!HOSTPORT.test(pairAddr.trim()) || code.length !== 6 || !!busy} onClick={() => void run("pair", () => api.wifiPair(pairAddr.trim(), code), () => "Paired. Now connect using the address on the main Wireless debugging screen.")} className="rounded-md border px-3 py-1.5 disabled:opacity-40" style={{ borderColor: "var(--border)" }}>Pair</button>
          </div>
        </Section>

        <Section title="Connect to an address" hint="The “IP address & port” shown on the phone's main Wireless debugging screen (or 5555 after “Go wireless”).">
          <div className="flex items-center gap-2">
            <input aria-label="Connect address" placeholder="192.168.1.37:37099" value={connectAddr} onChange={(e) => setConnectAddr(e.target.value)} className={input + " w-64"} style={{ borderColor: "var(--border)" }} />
            <button disabled={!HOSTPORT.test(connectAddr.trim()) || !!busy} onClick={() => void run("connect", () => api.wifiConnect(connectAddr.trim()), (m) => m || "Connected")} className="rounded-md border px-3 py-1.5 disabled:opacity-40" style={{ borderColor: "var(--border)" }}>Connect</button>
          </div>
        </Section>

        <Section title="Found on your network" hint="Phones with Wireless debugging turned on appear here automatically.">
          {found.length === 0 ? <p className="text-[12px]" style={{ color: "var(--fg-muted)" }}>Nothing found yet.</p> : (
            <ul className="flex flex-col gap-1">
              {found.map((s) => (
                <li key={s.name + s.kind} className="flex items-center gap-2 text-[13px]">
                  <Wifi size={14} className="text-[var(--color-accent)]" /><span className="flex-1 select-text truncate">{s.name} · {s.address}</span>
                  <span className="rounded bg-[var(--hover)] px-1.5 text-[10px]">{s.kind.includes("pairing") ? "needs pairing" : "ready"}</span>
                  {s.kind.includes("connect") ? <button onClick={() => void run(`c-${s.address}`, () => api.wifiConnect(s.address), () => `Connected to ${s.address}`)} className="rounded-md border px-2 py-1 text-[12px]" style={{ borderColor: "var(--border)" }}>Connect</button>
                    : <button onClick={() => setPairAddr(s.address)} className="rounded-md border px-2 py-1 text-[12px]" style={{ borderColor: "var(--border)" }}>Use for pairing</button>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
