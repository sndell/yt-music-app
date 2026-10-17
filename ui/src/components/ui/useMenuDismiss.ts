import { useEffect, useRef } from "react";
import { announceMenuOpen, isInsideMenuFlyout, isProgrammaticScroll, onOtherMenuOpen } from "./menuDom";

/**
 * Close a menu when the pointer goes down outside it, on Escape, on a user
 * scroll, or on a resize.
 *
 * Six menus each carried their own copy of this, in four slightly different
 * shapes. `trigger` is the button the menu hangs off, so pressing it does not
 * read as a click outside; `flyoutAware` keeps a click inside a hover flyout
 * from closing the parent menu.
 */
export const useMenuDismiss = ({
  ref,
  onClose,
  trigger,
  flyoutAware = true,
  enabled = true,
}: {
  ref: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  trigger?: HTMLElement | null;
  flyoutAware?: boolean;
  enabled?: boolean;
}) => {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!enabled) return;
    const inside = (target: EventTarget | null) => {
      if (ref.current?.contains(target as Node)) return true;
      if (flyoutAware && isInsideMenuFlyout(target)) return true;
      if (trigger && target instanceof Node && trigger.contains(target)) return true;
      return false;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (inside(event.target)) return;
      closeRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    const onScroll = (event: Event) => {
      if (inside(event.target)) return;
      if (isProgrammaticScroll()) return;
      closeRef.current();
    };
    const onResize = () => closeRef.current();

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [ref, trigger, flyoutAware, enabled]);
};

/**
 * Announce this menu so any other open menu closes, and close when another one
 * opens. Four menus carried the pair; the other three did not announce at all.
 */
export const useMenuLifecycle = (menuId: number, onClose: () => void) => {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    announceMenuOpen(menuId);
    return onOtherMenuOpen(menuId, () => closeRef.current());
  }, [menuId]);
};
