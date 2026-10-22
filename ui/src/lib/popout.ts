import { useEffect, useState } from "react";
import { PyBridge } from "@/lib/api";
import type { PopoutPrefs } from "@/lib/api/types";

/**
 * The always-on-top player's settings, kept in Python's preferences.json.
 *
 * A module-cache singleton instead of a React context: Settings is the only
 * writer of `enabled`, the player bar only needs `enabled` and `open`, and the
 * popout reads `pinned` through its own bridge call. Its collapsed state comes
 * from its own viewport height, which is the one thing that cannot go stale.
 */
const listeners = new Set<(prefs: PopoutPrefs) => void>();
let cached: PopoutPrefs | null = null;

const DEFAULT_PREFS: PopoutPrefs = { enabled: false, open: false, pinned: true, collapsed: false };

const publish = (prefs: PopoutPrefs) => {
  cached = prefs;
  for (const listener of listeners) listener(prefs);
};

/** Turn the feature on or off. Turning it on opens the window. */
export const setPopoutEnabled = async (enabled: boolean) => {
  const result = await PyBridge.setPopout(enabled);
  if (result.success) publish(result.data);
  return result;
};

export const openPopout = async () => {
  const result = await PyBridge.openPopout();
  if (result.success) publish(result.data);
  return result;
};

/** Also the path the popout's own close button takes, so this window stays in step. */
export const closePopout = async () => {
  const result = await PyBridge.closePopout();
  if (result.success) publish(result.data);
  return result;
};

export const usePopout = () => {
  const [prefs, setPrefs] = useState(cached);
  useEffect(() => {
    listeners.add(setPrefs);
    if (cached == null) {
      void PyBridge.getPopout().then((result) => {
        if (result.success) publish(result.data);
      });
    }
    // The popout can be closed from its own corner or Alt+F4, which Python sees
    // and this window does not. Re-reading on focus keeps the player bar's
    // button honest without polling.
    const refresh = () => {
      void PyBridge.getPopout().then((result) => {
        if (result.success) publish(result.data);
      });
    };
    window.addEventListener("focus", refresh);
    return () => {
      listeners.delete(setPrefs);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return prefs ?? DEFAULT_PREFS;
};
