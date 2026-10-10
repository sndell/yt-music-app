import { useCallback, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

const DRAG_THRESHOLD_PX = 6;
const SNAP_EPSILON_PX = 1;

const contentLeft = (scroller: HTMLElement, child: HTMLElement) =>
  child.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft;

const columnGap = (scroller: HTMLElement) => {
  const styles = getComputedStyle(scroller);
  return Number.parseFloat(styles.columnGap || styles.gap) || 0;
};

const itemsOf = (scroller: HTMLElement, pad: HTMLElement) =>
  Array.from(scroller.children).filter((node): node is HTMLElement => node instanceof HTMLElement && node !== pad);

const setPadWidth = (pad: HTMLElement, width: number) => {
  const next = width > SNAP_EPSILON_PX ? Math.ceil(width) : 0;
  const current = pad.hidden ? 0 : Math.round(pad.getBoundingClientRect().width);
  if (next === 0) {
    if (pad.hidden) return;
    pad.hidden = true;
    pad.style.width = "0px";
    return;
  }
  if (!pad.hidden && Math.abs(current - next) <= SNAP_EPSILON_PX) return;
  pad.hidden = false;
  pad.style.width = `${next}px`;
};

/** Extra trailing space so the last card can snap to the start of the row. */
const syncPad = (scroller: HTMLElement, pad: HTMLElement, items: HTMLElement[]) => {
  const last = items[items.length - 1];
  if (!last) {
    setPadWidth(pad, 0);
    return;
  }
  const padWidth = pad.hidden ? 0 : pad.getBoundingClientRect().width;
  const gap = pad.hidden ? 0 : columnGap(scroller);
  const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const maxWithoutPad = Math.max(0, max - padWidth - gap);
  if (maxWithoutPad <= SNAP_EPSILON_PX) {
    setPadWidth(pad, 0);
    return;
  }
  setPadWidth(pad, contentLeft(scroller, last) - maxWithoutPad);
};

const chevronClass =
  "absolute top-1/2 grid size-8 -translate-y-1/2 cursor-pointer place-items-center rounded-full border border-primary bg-primary opacity-0 transition duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] pointer-events-none group-hover/snap:pointer-events-auto group-hover/snap:opacity-100 hover:bg-primary-light focus-visible:pointer-events-auto focus-visible:opacity-100";

const FADE = "5rem";

const edgeMask = (previous: boolean, next: boolean) => {
  if (previous && next) {
    return `linear-gradient(to right, transparent, #000 ${FADE}, #000 calc(100% - ${FADE}), transparent)`;
  }
  if (previous) return `linear-gradient(to right, transparent, #000 ${FADE})`;
  if (next) return `linear-gradient(to left, transparent, #000 ${FADE})`;
  return "";
};

/** Parent section uses `group/snap` so the chevrons fade in while that section is hovered. */
export const SnapRow = ({ children }: { children: ReactNode }) => {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const padRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLButtonElement>(null);
  const rightRef = useRef<HTMLButtonElement>(null);
  const pendingLeftRef = useRef<number | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const settleCleanupRef = useRef<(() => void) | null>(null);
  const clickCleanupRef = useRef<(() => void) | null>(null);

  const updateEdges = useCallback(() => {
    const scroller = scrollerRef.current;
    const pad = padRef.current;
    const leftButton = leftRef.current;
    const rightButton = rightRef.current;
    if (!scroller || !pad || !leftButton || !rightButton) return;
    const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const origin = pendingLeftRef.current ?? scroller.scrollLeft;
    let previous = false;
    let next = false;
    for (const item of itemsOf(scroller, pad)) {
      const position = Math.min(contentLeft(scroller, item), max);
      if (position < origin - SNAP_EPSILON_PX) previous = true;
      if (position > origin + SNAP_EPSILON_PX) next = true;
    }
    if (leftButton.hidden !== !previous) leftButton.hidden = !previous;
    if (rightButton.hidden !== !next) rightButton.hidden = !next;
    const mask = edgeMask(previous, next);
    if (scroller.dataset.edgeMask !== mask) {
      scroller.dataset.edgeMask = mask;
      scroller.style.maskImage = mask;
      scroller.style.webkitMaskImage = mask;
    }
  }, []);

  const sync = useCallback(() => {
    const scroller = scrollerRef.current;
    const pad = padRef.current;
    if (!scroller || !pad) return;
    syncPad(scroller, pad, itemsOf(scroller, pad));
    updateEdges();
  }, [updateEdges]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const resize = new ResizeObserver(sync);
    const watch = () => {
      resize.observe(scroller);
      for (const child of scroller.children) resize.observe(child);
    };
    const onScroll = () => updateEdges();
    const onScrollEnd = () => {
      pendingLeftRef.current = null;
      updateEdges();
    };
    const onWheel = () => {
      pendingLeftRef.current = null;
    };
    watch();
    sync();
    const mutations = new MutationObserver(() => {
      watch();
      sync();
    });
    mutations.observe(scroller, { childList: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("scrollend", onScrollEnd);
    scroller.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      resize.disconnect();
      mutations.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("scrollend", onScrollEnd);
      scroller.removeEventListener("wheel", onWheel);
      dragCleanupRef.current?.();
      settleCleanupRef.current?.();
      clickCleanupRef.current?.();
      document.body.style.cursor = "";
    };
  }, [sync, updateEdges]);

  const scrollToItem = (left: number) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    settleCleanupRef.current?.();
    settleCleanupRef.current = null;
    scroller.style.scrollSnapType = "";
    pendingLeftRef.current = left;
    scroller.scrollTo({ left, behavior: "smooth" });
    updateEdges();
  };

  const scrollByItem = (direction: -1 | 1) => {
    const scroller = scrollerRef.current;
    const pad = padRef.current;
    if (!scroller || !pad) return;
    const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const origin = pendingLeftRef.current ?? scroller.scrollLeft;
    const positions = itemsOf(scroller, pad).map((item) => Math.min(contentLeft(scroller, item), max));
    const target =
      direction === 1
        ? positions.find((position) => position > origin + SNAP_EPSILON_PX)
        : [...positions].reverse().find((position) => position < origin - SNAP_EPSILON_PX);
    if (target == null) return;
    scrollToItem(target);
  };

  const settleNearest = (scroller: HTMLElement) => {
    const pad = padRef.current;
    if (!pad) return;
    const items = itemsOf(scroller, pad);
    if (items.length === 0) {
      scroller.style.scrollSnapType = "";
      return;
    }
    const origin = scroller.getBoundingClientRect().left;
    let best = items[0];
    let bestDistance = Infinity;
    for (const item of items) {
      const distance = Math.abs(item.getBoundingClientRect().left - origin);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = item;
      }
    }
    const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const left = Math.min(contentLeft(scroller, best), max);
    if (Math.abs(left - scroller.scrollLeft) <= SNAP_EPSILON_PX) {
      scroller.style.scrollSnapType = "";
      pendingLeftRef.current = null;
      updateEdges();
      return;
    }
    scroller.style.scrollSnapType = "none";
    pendingLeftRef.current = left;
    scroller.scrollTo({ left, behavior: "smooth" });
    let timer = 0;
    const finish = () => {
      scroller.removeEventListener("scrollend", finish);
      window.clearTimeout(timer);
      scroller.style.scrollSnapType = "";
      if (pendingLeftRef.current === left) pendingLeftRef.current = null;
      settleCleanupRef.current = null;
      updateEdges();
    };
    timer = window.setTimeout(finish, 700);
    settleCleanupRef.current = () => {
      scroller.removeEventListener("scrollend", finish);
      window.clearTimeout(timer);
      settleCleanupRef.current = null;
    };
    scroller.addEventListener("scrollend", finish);
    updateEdges();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    dragCleanupRef.current?.();
    settleCleanupRef.current?.();
    pendingLeftRef.current = null;
    scroller.style.scrollSnapType = "";

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startScroll = scroller.scrollLeft;
    let moved = false;

    const restore = () => {
      scroller.style.cursor = "";
      scroller.style.userSelect = "";
      document.body.style.cursor = "";
    };

    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (dragCleanupRef.current === detach) dragCleanupRef.current = null;
    };

    const suppressNextClick = () => {
      clickCleanupRef.current?.();
      const root = scroller.parentElement;
      let timer = 0;
      const remove = () => {
        window.clearTimeout(timer);
        window.removeEventListener("click", suppress, true);
        if (clickCleanupRef.current === remove) clickCleanupRef.current = null;
      };
      const suppress = (clickEvent: MouseEvent) => {
        const target = clickEvent.target;
        if (!(target instanceof Node) || !root?.contains(target)) return;
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        remove();
      };
      timer = window.setTimeout(remove, 400);
      window.addEventListener("click", suppress, true);
      clickCleanupRef.current = remove;
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      if (!moved) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
        moved = true;
        scroller.style.scrollSnapType = "none";
        scroller.style.cursor = "grabbing";
        scroller.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
        if (scroller.isConnected && !scroller.hasPointerCapture(pointerId)) {
          try {
            scroller.setPointerCapture(pointerId);
          } catch {
            // The pointer can end between the move and the capture call.
          }
        }
      }
      ev.preventDefault();
      scroller.scrollLeft = startScroll - dx;
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const didMove = moved;
      try {
        if (scroller.isConnected && scroller.hasPointerCapture(pointerId)) scroller.releasePointerCapture(pointerId);
      } catch {
        // The pointer can already be gone when the gesture ends.
      }
      detach();
      restore();
      if (!didMove) return;
      suppressNextClick();
      settleNearest(scroller);
    };

    dragCleanupRef.current = detach;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div className="relative mt-3 min-w-0">
      <div
        ref={scrollerRef}
        onPointerDown={onPointerDown}
        onDragStart={(event) => event.preventDefault()}
        className="flex w-full cursor-grab touch-pan-y gap-3 overflow-x-auto overflow-y-hidden pb-1 scrollbar-none snap-x snap-mandatory overscroll-x-contain *:snap-start"
      >
        {children}
        <div
          ref={padRef}
          data-snap-pad
          aria-hidden
          style={{ scrollSnapAlign: "none" }}
          className="pointer-events-none shrink-0"
        />
      </div>
      <button type="button" ref={leftRef} aria-label="Previous" onClick={() => scrollByItem(-1)} className={`${chevronClass} left-0`}>
        <span className="icon-[solar--alt-arrow-left-linear] text-lg" />
      </button>
      <button type="button" ref={rightRef} aria-label="Next" onClick={() => scrollByItem(1)} className={`${chevronClass} right-0`}>
        <span className="icon-[solar--alt-arrow-right-linear] text-lg" />
      </button>
    </div>
  );
};
