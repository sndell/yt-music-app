import {
  useLayoutEffect,
  useRef,
  useState,
  type FocusEventHandler,
  type PointerEvent as ReactPointerEvent,
  type PointerEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/util/cn";

/** Keep the thumb grabbable on very long lists. */
const MIN_THUMB = 24;
/** Track inset, so the thumb clears the panel's rounded corners. */
const TRACK_INSET = 6;
/** How long the thumb lingers after a scroll before fading out. */
const IDLE_HIDE_MS = 900;

type OverlayScrollProps = {
  children: ReactNode;
  /** Classes for the wrapper that positions the thumb. */
  className?: string;
  /** Classes for the scrollable element itself. */
  viewportClassName?: string;
  /** The scrollable element, for callers that measure it or attach edge fades. */
  viewportRef?: RefObject<HTMLDivElement | null>;
  onPointerMove?: PointerEventHandler<HTMLDivElement>;
  onPointerOut?: PointerEventHandler<HTMLDivElement>;
  onFocus?: FocusEventHandler<HTMLDivElement>;
  onBlur?: FocusEventHandler<HTMLDivElement>;
};

/**
 * Vertical scroller whose thumb floats over the content instead of sitting in
 * the layout. The native bar is hidden, so the content keeps the panel's full
 * width and rows do not shift when the list starts to overflow.
 */
export const OverlayScroll = ({
  children,
  className,
  viewportClassName,
  viewportRef,
  onPointerMove,
  onPointerOut,
  onFocus,
  onBlur,
}: OverlayScrollProps) => {
  const localRef = useRef<HTMLDivElement>(null);
  const ref = viewportRef ?? localRef;
  const [thumb, setThumb] = useState<{ top: number; height: number } | null>(null);
  const [hovering, setHovering] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const thumbHeightRef = useRef(0);
  const hideTimer = useRef(0);
  const dragging = useRef<{ pointerId: number; startY: number; startTop: number } | null>(null);

  const hideSoon = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setScrolling(false), IDLE_HIDE_MS);
  };

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = () => {
      const { scrollHeight, clientHeight, scrollTop } = element;
      const track = clientHeight - TRACK_INSET * 2;
      if (clientHeight === 0 || track <= 0 || scrollHeight <= clientHeight + 1) {
        thumbHeightRef.current = 0;
        setThumb(null);
        return;
      }
      const height = Math.min(track, Math.max(MIN_THUMB, Math.round((clientHeight / scrollHeight) * clientHeight)));
      const maxTop = track - height;
      const maxScroll = scrollHeight - clientHeight;
      thumbHeightRef.current = height;
      setThumb({ top: TRACK_INSET + (maxScroll > 0 ? (scrollTop / maxScroll) * maxTop : 0), height });
    };

    const onScroll = () => {
      measure();
      if (dragging.current) return;
      setScrolling(true);
      hideSoon();
    };

    // The observer reports the initial size too, so the thumb is measured on mount.
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    // Content can grow (or shrink) without the viewport box changing.
    const mutations = new MutationObserver(measure);
    mutations.observe(element, { childList: true, subtree: true });
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      resize.disconnect();
      mutations.disconnect();
      element.removeEventListener("scroll", onScroll);
      window.clearTimeout(hideTimer.current);
    };
  }, [ref]);

  const onThumbPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = ref.current;
    if (!element) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = { pointerId: event.pointerId, startY: event.clientY, startTop: element.scrollTop };
    window.clearTimeout(hideTimer.current);
    setScrolling(true);
  };

  const onThumbPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragging.current;
    const element = ref.current;
    if (!drag || !element || drag.pointerId !== event.pointerId) return;
    const maxScroll = element.scrollHeight - element.clientHeight;
    const maxTop = element.clientHeight - TRACK_INSET * 2 - thumbHeightRef.current;
    if (maxScroll <= 0 || maxTop <= 0) return;
    element.scrollTop = drag.startTop + ((event.clientY - drag.startY) * maxScroll) / maxTop;
  };

  const onThumbEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current?.pointerId !== event.pointerId) return;
    dragging.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    hideSoon();
  };

  const shown = hovering || scrolling;

  return (
    <div
      className={cn("relative min-h-0", className)}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => {
        setHovering(false);
        if (!dragging.current) {
          window.clearTimeout(hideTimer.current);
          setScrolling(false);
        }
      }}
    >
      <div
        ref={ref}
        onPointerMove={onPointerMove}
        onPointerOut={onPointerOut}
        onFocus={onFocus}
        onBlur={onBlur}
        className={cn("h-full scrollbar-none", viewportClassName)}
      >
        {children}
      </div>
      {thumb && (
        <div
          aria-hidden
          onPointerDown={onThumbPointerDown}
          onPointerMove={onThumbPointerMove}
          onPointerUp={onThumbEnd}
          onPointerCancel={onThumbEnd}
          style={{ height: thumb.height, transform: `translateY(${thumb.top}px)` }}
          className={cn(
            "absolute top-0 right-0.5 z-20 w-1 rounded-full bg-[color:var(--scrollbar-thumb)] transition-opacity duration-200 hover:bg-[color:var(--scrollbar-thumb-hover)]",
            shown ? "cursor-pointer opacity-100" : "pointer-events-none opacity-0",
          )}
        />
      )}
    </div>
  );
};
