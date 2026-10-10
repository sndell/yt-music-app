import { useLayoutEffect, useRef, useState, type TransitionEvent } from "react";
import { cn } from "@/util/cn";

const COLLAPSED_LINES = 3;

const textClass = "font-medium leading-6 wrap-anywhere text-primary-dark";
const actionClass =
  "inline cursor-pointer whitespace-nowrap border-0 bg-transparent p-0 align-baseline font-[inherit] text-[length:inherit] leading-[inherit] font-semibold text-primary hover:underline";

type Measure = {
  overflows: boolean;
  prefix: string;
  collapsed: number;
  expanded: number;
};

const ActionButton = ({
  label,
  pressed,
  hidden,
  onClick,
}: {
  label: string;
  pressed: boolean;
  hidden: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    className={actionClass}
    aria-expanded={pressed}
    aria-hidden={hidden}
    tabIndex={hidden ? -1 : 0}
    onClick={onClick}
  >{label}</button>
);

type PlaylistDescriptionProps = {
  description: string | null;
};

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const styleProbe = (probe: HTMLElement, source: CSSStyleDeclaration, width: number) => {
  probe.style.font = source.font;
  probe.style.lineHeight = source.lineHeight;
  probe.style.letterSpacing = source.letterSpacing;
  probe.style.wordSpacing = source.wordSpacing;
  probe.style.whiteSpace = "pre-line";
  probe.style.overflowWrap = "anywhere";
  probe.style.width = `${width}px`;
  probe.style.position = "fixed";
  probe.style.left = "0";
  probe.style.top = "0";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.margin = "0";
  probe.style.padding = "0";
  probe.style.boxSizing = "border-box";
};

const actionSpan = (label: string, source: CSSStyleDeclaration) => {
  const span = document.createElement("span");
  span.textContent = label;
  span.style.fontFamily = source.fontFamily;
  span.style.fontSize = source.fontSize;
  span.style.fontWeight = "600";
  span.style.lineHeight = source.lineHeight;
  span.style.whiteSpace = "nowrap";
  return span;
};

const fillCollapsed = (probe: HTMLElement, prefix: string, source: CSSStyleDeclaration) => {
  probe.replaceChildren();
  const trimmed = prefix.replace(/\s+$/u, "");
  if (trimmed) probe.append(document.createTextNode(trimmed));
  const chunk = document.createElement("span");
  chunk.style.whiteSpace = "nowrap";
  const hasEllipsis = trimmed.endsWith("…") || trimmed.endsWith("...");
  chunk.append(document.createTextNode(hasEllipsis ? " " : "… "));
  chunk.append(actionSpan("Show more", source));
  probe.append(chunk);
};

const fillExpanded = (probe: HTMLElement, value: string, source: CSSStyleDeclaration) => {
  probe.replaceChildren();
  const spacer = value.endsWith(" ") || value.endsWith("\n") ? value : `${value} `;
  probe.append(document.createTextNode(spacer));
  probe.append(actionSpan("Show less", source));
};

const measureDescription = (source: HTMLElement, text: string, width: number): Measure | null => {
  const computed = getComputedStyle(source);
  const probe = document.createElement("p");
  styleProbe(probe, computed, width);
  document.body.appendChild(probe);

  try {
    const lineHeight = Number.parseFloat(computed.lineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight <= 0 || width <= 0) return null;

    const maxHeight = lineHeight * COLLAPSED_LINES + 1;
    probe.textContent = text;
    const textHeight = probe.getBoundingClientRect().height;
    if (textHeight <= maxHeight) {
      return { overflows: false, prefix: text, collapsed: textHeight, expanded: textHeight };
    }

    const fits = (count: number) => {
      fillCollapsed(probe, text.slice(0, count), computed);
      return probe.getBoundingClientRect().height <= maxHeight;
    };

    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid;
      else high = mid - 1;
    }

    let cut = low;
    if (cut > 0 && cut < text.length) {
      const code = text.charCodeAt(cut);
      if (code >= 0xdc00 && code <= 0xdfff) cut -= 1;
    }

    const sample = text.slice(0, cut);
    const breakAt = Math.max(sample.lastIndexOf(" "), sample.lastIndexOf("\n"));
    if (breakAt > 0) {
      fillCollapsed(probe, text.slice(0, breakAt), computed);
      const snapped = probe.getBoundingClientRect().height;
      if (snapped > lineHeight * 2 + 1 && snapped <= maxHeight) cut = breakAt;
    }

    const prefix = text.slice(0, cut).replace(/\s+$/u, "");
    fillCollapsed(probe, prefix, computed);
    const collapsed = Math.ceil(probe.getBoundingClientRect().height);
    fillExpanded(probe, text, computed);
    const expanded = Math.ceil(probe.getBoundingClientRect().height);
    return { overflows: true, prefix, collapsed, expanded };
  } finally {
    probe.remove();
  }
};

export const PlaylistDescription = ({ description }: PlaylistDescriptionProps) => {
  const text = description?.trim() ?? "";
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [prefix, setPrefix] = useState("");
  const [height, setHeight] = useState<number | null>(null);
  const [animate, setAnimate] = useState(false);
  const [trackedText, setTrackedText] = useState(text);
  const frameRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLParagraphElement>(null);
  const expandedRef = useRef(false);
  const collapsedHeightRef = useRef(0);
  const expandedHeightRef = useRef(0);
  const toggleFrameRef = useRef(0);

  if (text !== trackedText) {
    setTrackedText(text);
    setExpanded(false);
    setOverflows(false);
    setPrefix("");
    setHeight(null);
    setAnimate(false);
    expandedRef.current = false;
  }

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const source = textRef.current;
    if (!frame || !source || !text) return;

    let lastWidth = -1;
    const measure = (force: boolean) => {
      const width = frame.clientWidth;
      if (width <= 0) return;
      // Height animation resizes this element. Only text or width changes need a new measure.
      if (!force && width === lastWidth) return;
      const result = measureDescription(source, text, width);
      if (!result) return;
      lastWidth = width;
      collapsedHeightRef.current = result.collapsed;
      expandedHeightRef.current = result.expanded;
      setOverflows(result.overflows);
      setPrefix(result.prefix);
      setAnimate(false);
      setHeight(result.overflows ? (expandedRef.current ? result.expanded : result.collapsed) : null);
      if (!result.overflows && expandedRef.current) {
        expandedRef.current = false;
        setExpanded(false);
      }
    };

    measure(true);
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(frame);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(toggleFrameRef.current);
    };
  }, [text]);

  const finishClose = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "height") return;
    setAnimate(false);
  };

  if (!text) {
    return <p className="pt-1.5 font-medium text-primary-dark opacity-90">No description</p>;
  }

  const toggle = () => {
    const next = !expandedRef.current;
    const nextHeight = next ? expandedHeightRef.current : collapsedHeightRef.current;
    if (!nextHeight) return;
    expandedRef.current = next;
    cancelAnimationFrame(toggleFrameRef.current);
    if (prefersReducedMotion()) {
      setAnimate(false);
      setExpanded(next);
      setHeight(nextHeight);
      return;
    }
    // Apply the transition, then change height on the next frame so it eases.
    setAnimate(true);
    toggleFrameRef.current = requestAnimationFrame(() => {
      setExpanded(next);
      setHeight(nextHeight);
    });
  };

  const motion =
    "transition-opacity duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

  return (
    <div className="min-w-0 pt-1.5">
      <div
        ref={frameRef}
        className={cn(
          "relative [overflow-anchor:none]",
          overflows && "overflow-hidden",
          animate &&
            "transition-[height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
        )}
        style={{ height: height ?? undefined }}
        onTransitionEnd={finishClose}
      >
        <p
          ref={textRef}
          aria-hidden={overflows && !expanded}
          className={cn(textClass, overflows && motion, overflows && !expanded && "opacity-0")}
        >
          <span className="whitespace-pre-line opacity-90">{text}</span>
          {overflows && (
            <>
              {" "}
              <ActionButton label="Show less" pressed={expanded} hidden={!expanded} onClick={toggle} />
            </>
          )}
        </p>
        {overflows && (
          <p
            aria-hidden={expanded}
            className={cn(
              textClass,
              "absolute inset-x-0 top-0",
              motion,
              expanded && "opacity-0",
              expanded && !animate && "pointer-events-none",
            )}
          >
            {[
              <span key="prefix" className="whitespace-pre-line opacity-90">{prefix}</span>,
              <span key="more" className="whitespace-nowrap"><span className="opacity-90">{prefix.endsWith("…") || prefix.endsWith("...") ? " " : "… "}</span><ActionButton label="Show more" pressed={false} hidden={expanded} onClick={toggle} /></span>,
            ]}
          </p>
        )}
      </div>
    </div>
  );
};
