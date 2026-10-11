import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { api } from "../../lib/api";
import { useDevices } from "../../store/devices";
import { useFiles } from "../../store/files";
import { FilePane } from "./FilePane";
import { FunctionBar } from "./FunctionBar";
import { Places } from "./Places";
import { Toolbar } from "./Toolbar";
import { useFileShortcuts } from "./useFileShortcuts";

let lastSerial: string | null | undefined;

/** Draggable divider between the two panes. Arrow keys nudge it, double-click centres it. */
function Splitter({ container }: { container: React.RefObject<HTMLDivElement | null> }) {
  const setSplit = useFiles((s) => s.setSplit);
  const split = useFiles((s) => s.split);
  const [drag, setDrag] = useState(false);
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setDrag(true);
    const move = (ev: PointerEvent) => {
      const r = container.current?.getBoundingClientRect();
      if (r) setSplit((ev.clientX - r.left) / r.width);
    };
    const up = () => { setDrag(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      role="separator" aria-orientation="vertical" aria-label="Resize panes" aria-valuenow={Math.round(split * 100)} aria-valuemin={25} aria-valuemax={75} tabIndex={0}
      onPointerDown={onDown} onDoubleClick={() => setSplit(0.5)}
      onKeyDown={(e) => { if (e.key === "ArrowLeft") { e.preventDefault(); setSplit(split - 0.02); } else if (e.key === "ArrowRight") { e.preventDefault(); setSplit(split + 0.02); } }}
      className={clsx("group relative z-10 w-px shrink-0 cursor-col-resize", drag && "bg-[var(--color-accent)]")}
      style={{ background: drag ? undefined : "var(--border)" }}
    >
      <span className="absolute inset-y-0 -left-1.5 -right-1.5 group-hover:bg-[var(--selected)]" />
    </div>
  );
}

export function FilesView() {
  const { dual, layout, split } = useFiles();
  const devices = useDevices((s) => s.devices);
  const selected = useDevices((s) => s.selected);
  useFileShortcuts();
  const [home, setHome] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const name = devices.find((d) => d.serial === selected)?.model ?? "Phone";
  useEffect(() => { void api.localHome().then(setHome); }, []);
  // A different phone starts at its own storage root. (Coming back to Files, or arriving from Storage's
  // “Show in Files”, keeps the folder you were in.)
  useEffect(() => {
    if (lastSerial !== undefined && lastSerial !== selected) useFiles.getState().navigate("device", "/sdcard", { replace: true });
    lastSerial = selected;
  }, [selected]);

  const phone = <FilePane key="device" side="device" title={name} home={home} />;
  const mac = <FilePane key="local" side="local" title="Mac" home={home} />;
  const macFirst = layout === "macLeft";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar home={home} />
      <div className="flex min-h-0 flex-1">
        <Places home={home} />
        <div ref={wrap} className="flex min-w-0 flex-1">
          {dual ? (
            <>
              <div className="flex min-w-0" style={{ flex: `${split} 1 0%` }}>{macFirst ? mac : phone}</div>
              <Splitter container={wrap} />
              <div className="flex min-w-0" style={{ flex: `${1 - split} 1 0%` }}>{macFirst ? phone : mac}</div>
            </>
          ) : phone}
        </div>
      </div>
      {dual && <FunctionBar />}
    </div>
  );
}
