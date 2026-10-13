import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/util/cn";
import { MENU_FLYOUT_ATTR } from "./menuDom";

/**
 * A menu panel that opens beside the row it belongs to. It is portalled so the
 * parent menu's rounded corners do not clip it, and it animates in from the
 * edge it points at.
 */
export const MenuFlyout = ({
  anchor,
  width = 208,
  sideOffset = 6,
  onPointerEnter,
  onPointerLeave,
  children,
}: {
  /** Rect of the row this flyout opens beside. */
  anchor: DOMRect;
  width?: number;
  sideOffset?: number;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  children: ReactNode;
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;

    const place = () => {
      const rect = panel.getBoundingClientRect();
      const onRight = anchor.right + sideOffset + rect.width <= window.innerWidth - 8;
      const left = onRight
        ? anchor.right + sideOffset
        : Math.max(8, anchor.left - sideOffset - rect.width);
      let top = anchor.top - 6;
      if (top + rect.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - rect.height);
      if (top < 8) top = 8;
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.transformOrigin = `${onRight ? "left" : "right"} top`;
    };

    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [anchor, sideOffset]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      {...{ [MENU_FLYOUT_ATTR]: "" }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={{ width }}
      className={cn(
        "fixed z-[55] origin-left overflow-hidden rounded-2xl bg-black py-1 shadow-[0_10px_28px_rgb(0_0_0/0.65)]",
        "transition-[opacity,translate,scale] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
        "starting:-translate-x-1 starting:scale-95 starting:opacity-0",
      )}
    >
      {children}
    </div>,
    document.body,
  );
};
