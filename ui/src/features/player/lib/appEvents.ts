/**
 * The actions Python pushes through `window.pythonEvent`. One list so the
 * media-key path in `app/util/media_controls.py` and the handler in `Player.tsx`
 * cannot drift. `python app\dev\checks.py` compares the two.
 */
export const APP_EVENTS = ["play", "pause", "next", "previous"] as const;

export type AppEvent = (typeof APP_EVENTS)[number];
