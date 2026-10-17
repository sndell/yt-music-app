import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/util/cn";
import { useMenuDismiss } from "@/components/ui/useMenuDismiss";
import { chartCountryName } from "../lib/countryName";

/**
 * The chart country picker.
 *
 * YouTube lists every country it has a chart for, so the panel carries a search
 * box the way the language menu does. The list is the payload's own codes: the
 * app holds no country table.
 */
export const CountryMenu = ({
  open,
  trigger,
  codes,
  activeCode,
  onSelect,
  onClose,
}: {
  open: boolean;
  /** The button the menu opens under, for placement and outside-click checks. */
  trigger: HTMLButtonElement | null;
  codes: string[];
  activeCode: string;
  onSelect: (code: string) => void;
  onClose: () => void;
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const anchor = trigger?.getBoundingClientRect();
    if (!menu || !anchor) return;
    const rect = menu.getBoundingClientRect();
    const width = 216;
    let left = anchor.right - width;
    if (left < 8) left = Math.max(8, anchor.left);
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - width);
    const spaceBelow = window.innerHeight - anchor.bottom;
    const spaceAbove = anchor.top;
    const top =
      spaceBelow >= rect.height + 8 || spaceBelow >= spaceAbove
        ? anchor.bottom + 4
        : Math.max(8, anchor.top - rect.height - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.width = `${width}px`;
    menu.style.transformOrigin = `${top < anchor.top ? "bottom" : "top"} right`;
  }, [trigger]);

  useMenuDismiss({ ref: menuRef, onClose, trigger, flyoutAware: false });

  // The menu mounts fresh when it opens, so the search box starts empty and
  // picks up the keyboard through autoFocus. `open` still gates the search:
  // during the close animation a leftover query must not filter the list.
  const needle = open ? query.trim().toLowerCase() : "";
  const matches = needle
    ? codes.filter((code) => `${chartCountryName(code)} ${code}`.toLowerCase().includes(needle))
    : codes;

  const pick = (code: string) => {
    onSelect(code);
    onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className={cn(
        "fixed z-50 flex max-h-80 flex-col overflow-hidden rounded-xl bg-black p-1 shadow-[0_10px_28px_rgb(0_0_0/0.65)]",
        "transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] starting:scale-95 starting:opacity-0",
        open ? "scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0",
      )}
    >
      <div className="shrink-0 p-1">
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || matches.length === 0) return;
            event.preventDefault();
            pick(matches[0]);
          }}
          placeholder="Search countries"
          aria-label="Search countries"
          autoFocus
          className="w-full cursor-text rounded-lg bg-white/10 px-2.5 py-1.5 text-sm text-primary outline-none placeholder:text-primary-dark/60"
        />
      </div>
      <div className="overflow-y-auto overflow-x-hidden scrollbar-thin">
        {matches.map((code) => {
          const active = code === activeCode;
          return (
            <button
              key={code}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              tabIndex={-1}
              onClick={() => pick(code)}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors duration-150 hover:bg-white/10",
                active ? "text-primary" : "text-primary-dark hover:text-primary",
              )}
            >
              <span className="flex-1 min-w-0 truncate">{chartCountryName(code)}</span>
              <span className={cn("shrink-0 text-xs", active ? "text-accent" : "text-primary-dark")}>{code}</span>
            </button>
          );
        })}
        {matches.length === 0 && (
          <p className="grid place-items-center px-2 py-3 text-sm text-primary-dark">No country matches.</p>
        )}
      </div>
    </div>,
    document.body,
  );
};
