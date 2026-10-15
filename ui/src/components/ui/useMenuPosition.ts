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
      // offsetWidth/Height are the layout box: getBoundingClientRect() reports the
      // entrance animation's scale-95, and a transform never fires the observer,
      // so measuring with it left the menu a few pixels outside the window.
      const rect = menu.getBoundingClientRect();
      const width = menu.offsetWidth || rect.width;
      let height = menu.offsetHeight || rect.height;

      // A menu taller than the window cannot be placed inside it; cap it instead.
      const limit = window.innerHeight - 16;
      if (height > limit) {
        menu.style.maxHeight = `${limit}px`;
        menu.style.overflowY = "auto";
        height = limit;
      }

      let left = x;
      let top = y;
      if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - width);
      if (top + height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - height);
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
