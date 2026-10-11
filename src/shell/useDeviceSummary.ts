import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useDevices } from "../store/devices";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Everything the navigation chrome shows about the connected phone, from one place. */
export function useDeviceSummary() {
  const { devices, selected } = useDevices();
  const dev = devices.find((d) => d.serial === selected);
  const ready = dev?.state === "ready";
  const { data: info } = useQuery({ queryKey: ["deviceInfo", selected], queryFn: () => api.deviceInfo(selected!), enabled: ready, refetchInterval: 30_000 });
  const total = info?.storageTotal ?? 0;
  return {
    dev,
    devices,
    ready,
    name: info ? `${cap(info.manufacturer)} ${info.model}` : dev?.model ?? "Android phone",
    wireless: !!dev?.wireless,
    android: info?.androidVersion,
    battery: info?.batteryLevel ?? null,
    charging: !!info?.batteryCharging,
    free: total ? total - (info?.storageUsed ?? 0) : 0,
    total,
    usedPct: total ? ((info?.storageUsed ?? 0) / total) * 100 : 0,
    count: devices.length,
  };
}
