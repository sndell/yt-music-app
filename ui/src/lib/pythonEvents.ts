import type { AppEvent } from "@/features/player/lib/appEvents";

/**
 * The one owner of `window.pythonEvent`. Python pushes media keys (the player)
 * and session facts (Settings, the sidebar) through the same hook, so each
 * reader subscribes here instead of overwriting the others.
 */
type Handler = (payload?: unknown) => void;

const handlers = new Map<AppEvent, Set<Handler>>();

window.pythonEvent = (action: string, payload?: unknown) => {
  const set = handlers.get(action as AppEvent);
  if (!set) return;
  for (const handler of [...set]) handler(payload);
};

export const onPythonEvent = (action: AppEvent, handler: Handler) => {
  let set = handlers.get(action);
  if (!set) {
    set = new Set();
    handlers.set(action, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
  };
};
