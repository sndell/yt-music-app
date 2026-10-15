import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/util/cn";

/** Reading speed of the hover reveal, in pixels per second. */
const SPEED = 55;
const MIN_MS = 400;
const MAX_MS = 10000;

/**
 * What hover reveals the overflow:
 * `row` follows the track row's unnamed `group`, `self` only this text.
 * Classes are literal so Tailwind emits them.
 */
const REVEAL = {
  row: {
    transform:
      "group-hover:[transform:translateX(var(--scroll-shift))] group-hover:[transition-duration:var(--scroll-ms)] motion-reduce:group-hover:[transform:none]",
    mask: "group-hover:[mask-image:none]",
  },
  self: {
    transform:
      "hover:[transform:translateX(var(--scroll-shift))] hover:[transition-duration:var(--scroll-ms)] motion-reduce:hover:[transform:none]",
    mask: "hover:[mask-image:none]",
  },
} as const;

/**
 * Text that rests at a fixed width and scrolls to reveal the rest on hover.
 * Overflow is measured, so short text never moves and long text always scrolls
 * exactly to its last character. Omit `maxChars` to let the width follow the
 * surrounding column instead of a fixed cap.
 */
export const ScrollingText = ({
  children,
  maxChars,
  reveal = "row",
  className,
}: {
  children: ReactNode;
  /** Resting width, in characters (`ch`). Omit to follow the column width. */
  maxChars?: number;
  /** What hover reveals the overflow. `row` = the track row, `self` = this text. */
  reveal?: "row" | "self";
  className?: string;
}) => {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const measure = () => {
      const next = Math.max(0, Math.round(content.scrollWidth - viewport.clientWidth));
      setDistance((current) => (current === next ? current : next));
    };
    measure();
    // Set up once per mount: the observers catch later changes to the text or
    // the `maxChars` width, so re-measuring on every render (which forces a
    // reflow) is not needed and makes long lists janky while scrolling.
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const overflowing = distance > 1;
  const duration = Math.min(MAX_MS, Math.max(MIN_MS, Math.round((distance / SPEED) * 1000)));

  return (
    <span
      ref={viewportRef}
      style={maxChars == null ? undefined : { maxWidth: `${maxChars}ch` }}
      className={cn(
        "relative block min-w-0 overflow-hidden",
        overflowing && cn("fade-truncate", REVEAL[reveal].mask),
        className
      )}
    >
      <span
        ref={contentRef}
        style={{ "--scroll-shift": `-${distance}px`, "--scroll-ms": `${duration}ms` } as CSSProperties}
        className={cn(
          "block whitespace-nowrap transition-transform duration-300 ease-linear",
          overflowing && REVEAL[reveal].transform
        )}
      >
        {children}
      </span>
    </span>
  );
};
