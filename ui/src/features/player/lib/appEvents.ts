/**
 * The actions Python pushes through `window.pythonEvent`. One list so the
 * media-key path in `app/util/media_controls.py`, the direct `dispatch_event`
 * calls, and the handlers cannot drift. `python app\dev\checks.py` compares them.
 */
export const APP_EVENTS = ["play", "pause", "next", "previous", "sessionExpired"] as const;

export type AppEvent = (typeof APP_EVENTS)[number];
