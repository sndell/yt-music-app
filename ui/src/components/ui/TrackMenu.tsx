import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

const itemClass =
  "group flex w-full cursor-pointer items-center gap-2.5 px-2.5 py-2 text-left text-sm text-primary transition-colors duration-150 hover:bg-white/10";

const iconClass = "shrink-0 text-lg text-primary-dark transition-colors duration-150 group-hover:text-primary";

export const TrackMenu = ({
  x,
  y,
  onClose,
  onShuffle,
  onStartMix,
  onPlayNext,
  onAddToQueue,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onShuffle?: () => void;
  onStartMix: () => void;
  onPlayNext: () => void;
  onAddToQueue: () => void;
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - rect.width);
    if (top + rect.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - rect.height);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.transformOrigin = `${left < x ? "right" : "left"} ${top < y ? "bottom" : "top"}`;
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const choose = (action: () => void) => {
    action();
    onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{ left: x, top: y }}
      onContextMenu={(event) => event.preventDefault()}
      className="fixed z-50 w-44 origin-top-left rounded-2xl overflow-hidden bg-black shadow-[0_10px_28px_rgb(0_0_0/0.65)] transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] starting:scale-95 starting:opacity-0"
    >
      {onShuffle && (
        <button type="button" role="menuitem" className={itemClass} onClick={() => choose(onShuffle)}>
          <span className={`${iconClass} icon-[solar--shuffle-linear]`} />
          Shuffle
        </button>
      )}
      <button type="button" role="menuitem" className={itemClass} onClick={() => choose(onStartMix)}>
        <span className={`${iconClass} icon-[solar--soundwave-linear]`} />
        Start mix
      </button>
      <button type="button" role="menuitem" className={itemClass} onClick={() => choose(onPlayNext)}>
        <span className={`${iconClass} icon-[solar--plaaylist-minimalistic-line-duotone]`} />
        Play next
      </button>
      <button type="button" role="menuitem" className={itemClass} onClick={() => choose(onAddToQueue)}>
        <span className={`${iconClass} icon-[solar--list-arrow-down-minimalistic-bold-duotone]`} />
        Add to queue
      </button>
    </div>,
    document.body
  );
};
