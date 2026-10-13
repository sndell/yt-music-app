import { useLayoutEffect, type RefObject } from "react";

/**
 * Keep a portal menu inside the viewport. It re-places itself whenever the menu
 * changes size, so expanding sections stay on screen instead of overflowing the
 * bottom edge.
 */
export const useMenuPosition = (ref: RefObject<HTMLElement | null>, x: number, y: number) => {
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;

    const place = () => {
      const rect = menu.getBoundingClientRect();
      let left = x;
      let top = y;
      if (left + rect.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - rect.width);
      if (top + rect.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - rect.height);
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      menu.style.transformOrigin = `${left < x ? "right" : "left"} ${top < y ? "bottom" : "top"}`;
    };

    place();
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [ref, x, y]);
};
