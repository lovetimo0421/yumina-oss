/**
 * Tape fast-forward / rewind over the realtime film while a skipped-to (or rewound-to) shot is
 * on its way: a live stream cannot play faster or backwards, so the picture shows the seek
 * (tracking lines, jitter, ▶▶ or ◀◀) until the new shot is on screen, then flashes into it.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RealtimeVideoController } from "./controller";

const CSS = `
@keyframes rtv-ff-lines { from { background-position: 0 0; } to { background-position: 0 -64px; } }
@keyframes rtv-ff-band { 0% { top: -18%; } 100% { top: 108%; } }
@keyframes rtv-rw-band { 0% { top: 108%; } 100% { top: -18%; } }
@keyframes rtv-rw-lines { from { background-position: 0 -64px; } to { background-position: 0 0; } }
@keyframes rtv-ff-jitter { 0%,100% { transform: translate(0,0) scale(1.03); } 25% { transform: translate(-3px,1px) scale(1.03); } 50% { transform: translate(2px,-1px) scale(1.03); } 75% { transform: translate(-1px,2px) scale(1.03); } }
@keyframes rtv-ff-blink { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
@keyframes rtv-ff-flash { from { opacity: .85; } to { opacity: 0; } }
.rtv-ff-on video { filter: blur(1.6px) contrast(1.25) saturate(.55) brightness(1.08); animation: rtv-ff-jitter .12s steps(2) infinite; }
`;

export function FastForwardVeil({ controller }: { controller: RealtimeVideoController }) {
  const ffMark = useSyncExternalStore((cb) => controller.subscribe(cb), () => controller.getState().fastForward ?? null);
  const rwMark = useSyncExternalStore((cb) => controller.subscribe(cb), () => controller.getState().rewind ?? null);
  const ff = ffMark ?? rwMark;
  const back = !ffMark && !!rwMark;
  const veil = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(0);
  const was = useRef(false);

  // The video sits in the sibling element: switch its look with a class on the shared parent.
  useEffect(() => {
    const parent = veil.current?.parentElement;
    if (!parent) return;
    parent.classList.toggle("rtv-ff-on", !!ff);
    if (was.current && !ff) setFlash(Date.now());
    was.current = !!ff;
  }, [ff]);
  useEffect(() => () => veil.current?.parentElement?.classList.remove("rtv-ff-on"), []);

  return (
    <div ref={veil} className="absolute inset-0">
      <style>{CSS}</style>
      {ff && (
        <>
          <div className="absolute inset-0" style={{ background: "repeating-linear-gradient(0deg, rgba(255,255,255,.07) 0 2px, transparent 2px 6px)", animation: back ? "rtv-rw-lines .25s linear infinite" : "rtv-ff-lines .25s linear infinite" }} />
          <div className="absolute inset-x-0" style={{ height: "14%", background: "linear-gradient(180deg, transparent, rgba(255,255,255,.28) 40%, rgba(200,220,255,.18) 60%, transparent)", mixBlendMode: "screen", animation: back ? "rtv-rw-band .9s linear infinite" : "rtv-ff-band .9s linear infinite" }} />
          <div className="absolute" style={{ left: "4%", top: "6%", color: "#fff", font: "600 clamp(16px, 3.4vw, 34px)/1 ui-monospace, Consolas, monospace", letterSpacing: ".08em", textShadow: "0 0 8px rgba(0,0,0,.8), 2px 0 0 rgba(255,60,60,.6), -2px 0 0 rgba(60,200,255,.6)", animation: "rtv-ff-blink .7s steps(2) infinite" }}>
            {back ? "◀◀" : "▶▶"} <span style={{ fontSize: "55%", letterSpacing: ".3em" }}>{back ? "REWIND" : "FAST FORWARD"}</span>
          </div>
        </>
      )}
      {flash > 0 && <div key={flash} className="absolute inset-0 bg-white" style={{ animation: "rtv-ff-flash .45s ease-out forwards" }} />}
    </div>
  );
}
