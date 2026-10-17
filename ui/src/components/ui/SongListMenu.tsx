import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TrackSort } from "@/features/playlist/components/trackFilter";
import { nextMenuId } from "./menuDom";
import { useMenuDismiss, useMenuLifecycle } from "./useMenuDismiss";
import { useMenuPosition } from "./useMenuPosition";

const itemClass =
  "group flex w-full cursor-pointer items-center gap-2.5 px-2.5 py-2 text-left text-sm text-primary transition-colors duration-150 hover:bg-white/10";

const iconClass = "shrink-0 text-lg text-primary-dark transition-colors duration-150 group-hover:text-primary";

/** Row orders the menu offers, in the order it lists them. */
const SORTS: { value: TrackSort; label: string; icon: string }[] = [
  { value: "playlist", label: "Playlist order", icon: "icon-[solar--playlist-linear]" },
  { value: "added-desc", label: "Date added (newest)", icon: "icon-[solar--sort-from-top-to-bottom-linear]" },
  { value: "added-asc", label: "Date added (oldest)", icon: "icon-[solar--sort-from-bottom-to-top-linear]" },
];

/**
 * Options for a collection's song list, opened from the kebab beside its search
 * field: narrow the list to songs that repeat, and choose the row order. Both
 * stay open after a pick so the check state is visible, like a checkbox.
 */
export const SongListMenu = ({
  x,
  y,
  trigger,
  duplicatesOnly,
  onToggleDuplicates,
  sort,
  onSort,
  onClose,
}: {
  x: number;
  y: number;
  /** The kebab that opened the menu; clicking it toggles instead of closing. */
  trigger?: HTMLElement | null;
  /** True while the list is narrowed to repeated songs. */
  duplicatesOnly: boolean;
  onToggleDuplicates: () => void;
  /** Current row order. */
  sort: TrackSort;
  onSort: (sort: TrackSort) => void;
  onClose: () => void;
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuId] = useState(() => nextMenuId());

  useMenuPosition(menuRef, x, y);

  useMenuLifecycle(menuId, onClose);
  useMenuDismiss({ ref: menuRef, onClose, trigger });

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{ left: x, top: y }}
      className="fixed z-50 w-56 origin-top-left overflow-hidden rounded-2xl bg-black shadow-[0_10px_28px_rgb(0_0_0/0.65)] transition-[scale,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] starting:scale-95 starting:opacity-0"
    >
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={duplicatesOnly}
        className={itemClass}
        onClick={onToggleDuplicates}
      >
        <span className={`${iconClass} icon-[solar--copy-linear]`} />
        <span className="min-w-0 flex-1 truncate">Find duplicates</span>
        {duplicatesOnly && <span className="shrink-0 text-base text-accent icon-[solar--check-circle-bold]" />}
      </button>
      <div className="my-1 h-px bg-white/10" role="separator" />
      <p className="px-2.5 pt-1 pb-1 text-xs font-medium tracking-wide text-primary-dark uppercase">Sort</p>
      {SORTS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitemradio"
          aria-checked={sort === option.value}
          className={itemClass}
          onClick={() => onSort(option.value)}
        >
          <span className={`${iconClass} ${option.icon}`} />
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          {sort === option.value && <span className="shrink-0 text-base text-accent icon-[solar--check-circle-bold]" />}
        </button>
      ))}
    </div>,
    document.body,
  );
};
