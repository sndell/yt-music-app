import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { nextMenuId } from "./menuDom";
import { useMenuDismiss, useMenuLifecycle } from "./useMenuDismiss";
import { useMenuPosition } from "./useMenuPosition";

const itemClass =
  "group flex w-full cursor-pointer items-center gap-2.5 px-2.5 py-2 text-left text-sm text-primary transition-colors duration-150 hover:bg-white/10";

const iconClass = "shrink-0 text-lg text-primary-dark transition-colors duration-150 group-hover:text-primary";

/**
 * The two ways to start a collection. It hangs off the Shuffle control so both
 * live in one button instead of two.
 */
export const ShuffleMenu = ({
  x,
  y,
  trigger,
  onClose,
  onShuffle,
  onTrueShuffle,
}: {
  x: number;
  y: number;
  /** The button that opened the menu; clicks on it toggle instead of closing. */
  trigger?: HTMLElement | null;
  onClose: () => void;
  onShuffle: () => void;
  onTrueShuffle: () => void;
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuId] = useState(() => nextMenuId());

  useMenuPosition(menuRef, x, y);

  useMenuLifecycle(menuId, onClose);
  useMenuDismiss({ ref: menuRef, onClose, trigger });

  const choose = (action: () => void) => {
    action();
    onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{ left: x, top: y }}
      className="fixed z-50 w-48 origin-top-left overflow-hidden rounded-2xl bg-black shadow-[0_10px_28px_rgb(0_0_0/0.65)] transition-[scale,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] starting:scale-95 starting:opacity-0"
    >
      <button type="button" role="menuitem" className={itemClass} onClick={() => choose(onShuffle)}>
        <span className={`${iconClass} icon-[solar--shuffle-linear]`} />
        Shuffle
      </button>
      <button type="button" role="menuitem" className={itemClass} onClick={() => choose(onTrueShuffle)}>
        <span className={`${iconClass} icon-[lucide--dices]`} />
        True random
      </button>
    </div>,
    document.body,
  );
};
