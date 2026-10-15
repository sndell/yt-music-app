import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/util/cn";
import { MenuFlyout } from "./MenuFlyout";
import { announceMenuOpen, isInsideMenuFlyout, nextMenuId, onOtherMenuOpen } from "./menuDom";
import { useMenuPosition } from "./useMenuPosition";

const itemClass =
  "group flex w-full cursor-pointer items-center gap-2.5 px-2.5 py-2 text-left text-sm text-primary transition-colors duration-150 hover:bg-white/10";

const iconClass = "shrink-0 text-lg text-primary-dark transition-colors duration-150 group-hover:text-primary";

const chevronClass =
  "shrink-0 text-lg text-primary-dark transition-[color,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:text-primary";

export const PlaylistMenu = ({
  x,
  y,
  onClose,
  onShuffle,
  onTrueShuffle,
  onStartMix,
  onPlayNext,
  onAddToQueue,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onShuffle: () => void;
  /** True-random (OS CSPRNG) shuffle of the whole playlist. */
  onTrueShuffle?: () => void;
  onStartMix: () => void;
  onPlayNext: () => void;
  onAddToQueue: () => void;
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [shuffleAnchor, setShuffleAnchor] = useState<DOMRect | null>(null);
  const [menuId] = useState(() => nextMenuId());

  useMenuPosition(menuRef, x, y);

  const cancelClose = () => {
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setShuffleAnchor(null);
    }, 200);
  };

  const closeFlyouts = () => {
    cancelClose();
    setShuffleAnchor(null);
  };

  const openShuffle = (element: HTMLElement) => {
    cancelClose();
    setShuffleAnchor(element.getBoundingClientRect());
  };

  useEffect(() => () => cancelClose(), []);

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    announceMenuOpen(menuId);
    return onOtherMenuOpen(menuId, () => onCloseRef.current());
  }, [menuId]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node) || isInsideMenuFlyout(event.target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node) || isInsideMenuFlyout(event.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const choose = (action: () => void) => {
    action();
    onClose();
  };

  return createPortal(
    <>
      <div
        ref={menuRef}
        role="menu"
        style={{ left: x, top: y }}
        onContextMenu={(event) => event.preventDefault()}
        onPointerLeave={scheduleClose}
        className="fixed z-50 w-48 origin-top-left overflow-hidden rounded-2xl bg-black shadow-[0_10px_28px_rgb(0_0_0/0.65)] transition-[scale,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] starting:scale-95 starting:opacity-0"
      >
        {onTrueShuffle ? (
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={shuffleAnchor != null}
            className={cn(itemClass, shuffleAnchor && "bg-white/10")}
            onClick={(event) => {
              if (!shuffleAnchor) openShuffle(event.currentTarget);
            }}
            onPointerEnter={(event) => openShuffle(event.currentTarget)}
          >
            <span className={`${iconClass} icon-[solar--shuffle-linear]`} />
            <span className="min-w-0 flex-1 truncate">Shuffle</span>
            <span className={`${chevronClass} icon-[solar--alt-arrow-right-linear]`} />
          </button>
        ) : (
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => choose(onShuffle)}
            onPointerEnter={closeFlyouts}
          >
            <span className={`${iconClass} icon-[solar--shuffle-linear]`} />
            Shuffle
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          onClick={() => choose(onStartMix)}
          onPointerEnter={closeFlyouts}
        >
          <span className={`${iconClass} icon-[solar--soundwave-linear]`} />
          Start mix
        </button>
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          onClick={() => choose(onPlayNext)}
          onPointerEnter={closeFlyouts}
        >
          <span className={`${iconClass} icon-[solar--playlist-minimalistic-line-duotone]`} />
          Play next
        </button>
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          onClick={() => choose(onAddToQueue)}
          onPointerEnter={closeFlyouts}
        >
          <span className={`${iconClass} icon-[solar--list-arrow-down-minimalistic-bold-duotone]`} />
          Add to queue
        </button>
      </div>

      {shuffleAnchor && onTrueShuffle && (
        <MenuFlyout anchor={shuffleAnchor} width={208} flush onPointerEnter={cancelClose} onPointerLeave={scheduleClose}>
          <button type="button" role="menuitem" className={itemClass} onClick={() => choose(onShuffle)}>
            <span className={`${iconClass} icon-[solar--shuffle-linear]`} />
            Shuffle
          </button>
          <button type="button" role="menuitem" className={itemClass} onClick={() => choose(onTrueShuffle)}>
            <span className={`${iconClass} icon-[lucide--dices]`} />
            True random
          </button>
        </MenuFlyout>
      )}
    </>,
    document.body,
  );
};
