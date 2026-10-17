/** The queue's genre tuner, anchored to the chip at the bottom of the panel. */

import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { WatchTunerChip } from "@/lib/api";
import { cn } from "@/util/cn";
import { useMenuDismiss } from "@/components/ui/useMenuDismiss";

export const TunerMenu = ({
  open,
  trigger,
  chips,
  value,
  onSelect,
  onClose,
}: {
  open: boolean;
  trigger: HTMLButtonElement | null;
  chips: WatchTunerChip[];
  value: string;
  onSelect: (chip: WatchTunerChip) => void;
  onClose: () => void;
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const anchor = trigger?.getBoundingClientRect();
    if (!menu || !anchor) return;
    // Match the trigger exactly so the menu reads as an extension of it.
    menu.style.width = `${anchor.width}px`;
    const rect = menu.getBoundingClientRect();
    let left = anchor.left;
    if (left + rect.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - rect.width);
    // The trigger sits at the bottom of the queue, so the menu opens upward
    // unless the space below is the better fit.
    const spaceBelow = window.innerHeight - anchor.bottom;
    const spaceAbove = anchor.top;
    const top =
      spaceBelow >= rect.height + 8 || spaceBelow >= spaceAbove
        ? anchor.bottom + 4
        : Math.max(8, anchor.top - rect.height - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    // Grow out of the corner nearest the trigger.
    menu.style.transformOrigin = `${left < anchor.left ? "right" : "left"} ${top < anchor.top ? "bottom" : "top"}`;
  }, [trigger]);

  useMenuDismiss({ ref: menuRef, onClose, trigger, flyoutAware: false });

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className={cn(
        "fixed z-50 max-h-80 overflow-y-auto overscroll-contain rounded-xl bg-black p-1 shadow-[0_10px_28px_rgb(0_0_0/0.65)] scrollbar-thin",
        "transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] starting:scale-95 starting:opacity-0",
        open ? "scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0"
      )}
    >
      {chips.map((chip, index) => {
        const active = chip.id === value;
        return (
          <button
            key={chip.id}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            style={{ animationDelay: open ? `${Math.min(index, 8) * 18}ms` : undefined }}
            onClick={() => {
              onSelect(chip);
              onClose();
            }}
            className={cn(
              "group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors duration-150 hover:bg-white/10",
              open && "animate-tuner-swap",
              active ? "text-primary" : "text-primary-dark hover:text-primary"
            )}
          >
            <span className="flex-1 min-w-0 truncate">{chip.text}</span>
            {active && <span className="shrink-0 text-base text-accent icon-[solar--check-circle-bold]" />}
          </button>
        );
      })}
    </div>,
    document.body
  );
};
