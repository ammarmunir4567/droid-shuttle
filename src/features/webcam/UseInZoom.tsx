import { useWebcam } from "../../store/webcam";
import { obsSteps, obsUrl } from "./helpers";
import { Card, CodeLine } from "./parts";

/** The OBS address plus the one-time recipe for Zoom / Meet. Highlighted while the camera is on. */
export function UseInZoom() {
  const info = useWebcam((s) => s.info);
  const port = useWebcam((s) => s.options.port);
  const url = info?.obsUrl ?? obsUrl(port);
  return (
    <Card title="Use it in Zoom / Meet" accent={info !== null}>
      <div className="flex flex-col gap-2.5">
        <CodeLine text={url} label="OBS URL" />
        {!info && <p className="text-[11.5px]" style={{ color: "var(--fg-muted)" }}>This is the address OBS will read. If the port is busy, the exact URL shows here once the webcam is on.</p>}
        <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[12.5px] leading-snug">
          {obsSteps(url).map((s) => <li key={s}>{s}</li>)}
        </ol>
        <p className="text-[11.5px]" style={{ color: "var(--fg-muted)" }}>If the video lags behind your voice, raise the microphone delay and start the webcam again.</p>
      </div>
    </Card>
  );
}
