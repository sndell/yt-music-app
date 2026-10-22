import { useEffect, useState } from "react";
import { PyBridge } from "@/lib/api";

/**
 * The crossfade length in seconds, kept in Python's preferences.json so it
 * survives a restart. Same shape as the horizontal nav toggle: a module-cache
 * singleton, because Settings is the only writer and the player is the only
 * reader that has to react while the window is open.
 */
const listeners = new Set<(seconds: number) => void>();
let cached: number | null = null;

const publish = (seconds: number) => {
  cached = seconds;
  for (const listener of listeners) listener(seconds);
};

/** Saves the choice through Python and notifies every reader on success. */
export const saveCrossfadeSeconds = async (seconds: number) => {
  const result = await PyBridge.setCrossfadeSeconds(seconds);
  if (result.success) publish(result.data);
  return result;
};

/** Zero while the stored value is still being read, which is also "off". */
export const useCrossfadeSeconds = () => {
  const [seconds, setSeconds] = useState(cached);
  useEffect(() => {
    listeners.add(setSeconds);
    if (cached == null) {
      void PyBridge.getCrossfadeSeconds().then((result) => {
        if (result.success) publish(result.data);
      });
    }
    return () => {
      listeners.delete(setSeconds);
    };
  }, []);
  return seconds ?? 0;
};
