import { useEffect, useState } from "react";
import { PyBridge } from "@/lib/api";

/**
 * Whether the visualizer offers its button in the player bar, kept in Python's
 * preferences.json. A module-cache singleton instead of a React context: the
 * only writer is Settings, and the only readers that need to react live are the
 * player bar and Settings itself.
 */
const listeners = new Set<(enabled: boolean) => void>();
let cached: boolean | null = null;

const publish = (enabled: boolean) => {
  cached = enabled;
  for (const listener of listeners) listener(enabled);
};

/** Saves the choice through Python and notifies every reader on success. */
export const saveVisualizerEnabled = async (enabled: boolean) => {
  const result = await PyBridge.setVisualizer(enabled);
  if (result.success) publish(result.data);
  return result;
};

export const useVisualizerEnabled = () => {
  const [enabled, setEnabled] = useState(cached);
  useEffect(() => {
    listeners.add(setEnabled);
    if (cached == null) {
      void PyBridge.getVisualizer().then((result) => {
        if (result.success) publish(result.data);
      });
    }
    return () => {
      listeners.delete(setEnabled);
    };
  }, []);
  return enabled ?? false;
};
