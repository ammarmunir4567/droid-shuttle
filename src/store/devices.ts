import { create } from "zustand";
import type { AdbDevice } from "../lib/api";

interface DeviceStore {
  devices: AdbDevice[];
  selected: string | null;
  adbError: string | null;
  setDevices: (d: AdbDevice[]) => void;
  select: (serial: string) => void;
  setAdbError: (e: string | null) => void;
}

export const useDevices = create<DeviceStore>((set, get) => ({
  devices: [],
  selected: null,
  adbError: null,
  // Keep the selection stable across hot-plug events; fall back to the first device.
  setDevices: (devices) => {
    const cur = get().selected;
    const selected = cur && devices.some((d) => d.serial === cur) ? cur : (devices[0]?.serial ?? null);
    set({ devices, selected, adbError: null });
  },
  select: (selected) => set({ selected }),
  setAdbError: (adbError) => set({ adbError }),
}));
