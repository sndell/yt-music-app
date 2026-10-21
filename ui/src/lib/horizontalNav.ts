import { useEffect, useState } from "react";
import { PyBridge } from "@/lib/api";

/**
 * The experimental horizontal nav toggle, kept in Python's preferences.json.
 * A module-cache singleton instead of a React context: the only writer is
 * Settings, and the only readers that need to react live are the Sidebar and
 * Settings itself.
 */
const listeners = new Set<(enabled: boolean) => void>();
let cached: boolean | null = null;

const publish = (enabled: boolean) => {
  cached = enabled;
  for (const listener of listeners) listener(enabled);
};

/** Saves the choice through Python and notifies every reader on success. */
export const saveHorizontalNav = async (enabled: boolean) => {
  const result = await PyBridge.setHorizontalNav(enabled);
  if (result.success) publish(result.data);
  return result;
};

export const useHorizontalNav = () => {
  const [enabled, setEnabled] = useState(cached);
  useEffect(() => {
    listeners.add(setEnabled);
    if (cached == null) {
      void PyBridge.getHorizontalNav().then((result) => {
        if (result.success) publish(result.data);
      });
    }
    return () => {
      listeners.delete(setEnabled);
    };
  }, []);
  return enabled ?? false;
};
