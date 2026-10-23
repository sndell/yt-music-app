import { useEffect, useRef } from "react";
import { usePlayer } from "../context/PlayerContext";
import {
  createAnalysisState,
  createVisualizerEngine,
  readAccent,
  readVisualizerFrame,
} from "../lib/visualizer";

/**
 * The visualizer scene for one open period. The engine builds its own canvas,
 * so this component only owns the lifecycle and the frame loop; the audio
 * itself is read per frame off whatever the player is playing right now.
 */
const VisualizerCanvas = ({ onClose }: { onClose: () => void }) => {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = createAnalysisState();
    const engine = createVisualizerEngine(host, readAccent());
    if (!engine) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const observer = new ResizeObserver(engine.resize);
    observer.observe(host);

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      const seconds = now / 1000;
      engine.render(readVisualizerFrame(state, seconds, dt), seconds, dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("keydown", onKey);
      engine.dispose();
    };
  }, [onClose]);

  return <div ref={hostRef} className="absolute inset-0" />;
};

/**
 * The visualizer, drawn over the sidebar and the routed content on black,
 * the same surface the music video uses. The queue and the player bar stay
 * put; the player bar's button and Escape both close it.
 */
export const VisualizerOverlay = () => {
  const { visualizerOpen, toggleVisualizer } = usePlayer();
  if (!visualizerOpen) return null;
  return (
    <div className="absolute inset-1.5 z-50 overflow-hidden rounded-xl bg-black">
      <VisualizerCanvas onClose={toggleVisualizer} />
    </div>
  );
};
