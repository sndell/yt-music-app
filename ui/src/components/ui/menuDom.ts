/** Attribute marking a menu flyout panel in the DOM. */
export const MENU_FLYOUT_ATTR = "data-menu-flyout";

/**
 * True when an event target is inside a menu flyout. Menus use this so a click
 * or scroll inside a flyout does not count as leaving the menu.
 */
export const isInsideMenuFlyout = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest(`[${MENU_FLYOUT_ATTR}]`));

// A scroll the page causes itself, such as the lyrics panel following the
// playing line, must not read as the user moving what a menu is anchored to.
let programmaticUntil = 0;

/** Keeps scroll-dismiss menus open for the next `ms`, while the app scrolls. */
export const suppressScrollDismiss = (ms: number) => {
  programmaticUntil = Math.max(programmaticUntil, Date.now() + ms);
};

/** True inside a window opened by `suppressScrollDismiss`. */
export const isProgrammaticScroll = () => Date.now() < programmaticUntil;

// Only one context menu should be open at a time. Every menu announces itself
// when it opens; the others close. Without this, right-clicking a song while a
// sidebar playlist menu is open leaves both on screen.
const MENU_OPEN_EVENT = "ytmusic-context-menu-open";
let menuSerial = 0;

/** Unique id for a menu, stable for the life of that menu. */
export const nextMenuId = () => ++menuSerial;

/** Tell every other open menu to close. */
export const announceMenuOpen = (id: number) => {
  window.dispatchEvent(new CustomEvent(MENU_OPEN_EVENT, { detail: { id } }));
};

/** Run `close` whenever a different menu opens. Returns an unsubscribe. */
export const onOtherMenuOpen = (id: number, close: () => void) => {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ id?: number }>).detail;
    if (!detail || detail.id == null || detail.id === id) return;
    close();
  };
  window.addEventListener(MENU_OPEN_EVENT, handler);
  return () => window.removeEventListener(MENU_OPEN_EVENT, handler);
};
