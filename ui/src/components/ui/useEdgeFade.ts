import { useLayoutEffect, type RefObject } from "react";

export const EDGE_FADE = "2.75rem";

/** Soften a clipped scroll edge. An edge that isn't cut stays solid. */
export const edgeMask = (top: boolean, bottom: boolean) => {
  if (top && bottom) {
    return `linear-gradient(to bottom, transparent, #000 ${EDGE_FADE}, #000 calc(100% - ${EDGE_FADE}), transparent)`;
  }
  if (top) return `linear-gradient(to bottom, transparent, #000 ${EDGE_FADE})`;
  if (bottom) return `linear-gradient(to top, transparent, #000 ${EDGE_FADE})`;
  return "";
};

export const applyEdgeMask = (element: HTMLElement, top: boolean, bottom: boolean) => {
  const mask = edgeMask(top, bottom);
  if (element.dataset.edgeMask === mask) return;
  element.dataset.edgeMask = mask;
  element.style.maskImage = mask;
  element.style.webkitMaskImage = mask;
};

/**
 * Fade clipped edges of a scroll container. `top: false` leaves the top solid,
 * which collection pages want so the cover isn't dimmed.
 */
export const useEdgeFade = (
  ref: RefObject<HTMLElement | null>,
  edges: { top?: boolean; bottom?: boolean } = {},
  watch?: unknown,
) => {
  const allowTop = edges.top !== false;
  const allowBottom = edges.bottom !== false;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const update = () => {
      const max = Math.max(0, element.scrollHeight - element.clientHeight);
      applyEdgeMask(element, allowTop && element.scrollTop > 1, allowBottom && max - element.scrollTop > 1);
    };

    update();
    const resize = new ResizeObserver(update);
    resize.observe(element);
    element.addEventListener("scroll", update, { passive: true });
    return () => {
      resize.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, [ref, allowTop, allowBottom, watch]);
};
