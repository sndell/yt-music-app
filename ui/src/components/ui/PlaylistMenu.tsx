import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PlaylistPrivacy } from "@/lib/api";
import { cn } from "@/util/cn";
import { MenuFlyout } from "./MenuFlyout";
import { announceMenuOpen, isInsideMenuFlyout, nextMenuId, onOtherMenuOpen } from "./menuDom";
import { useMenuPosition } from "./useMenuPosition";

const itemClass =
  "group flex w-full cursor-pointer items-center gap-2.5 px-2.5 py-2 text-left text-sm text-primary transition-colors duration-150 hover:bg-white/10";

const iconClass = "shrink-0 text-lg text-primary-dark transition-colors duration-150 group-hover:text-primary";

const chevronClass =
  "shrink-0 text-lg text-primary-dark transition-[color,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:text-primary";

const PRIVACY_OPTIONS: { value: PlaylistPrivacy; label: string; iconClass: string }[] = [
  { value: "PUBLIC", label: "Public", iconClass: "icon-[solar--globus-linear]" },
  { value: "UNLISTED", label: "Unlisted", iconClass: "icon-[solar--eye-linear]" },
  { value: "PRIVATE", label: "Private", iconClass: "icon-[solar--lock-keyhole-minimalistic-linear]" },
];

export const PlaylistMenu = ({
  x,
  y,
  onClose,
  onShuffle,
  onStartMix,
  onPlayNext,
  onAddToQueue,
  canEdit = false,
  onRename,
  onSetPrivacy,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onShuffle: () => void;
  onStartMix: () => void;
  onPlayNext: () => void;
  onAddToQueue: () => void;
  /** Owned playlists can be renamed and have their visibility changed. */
  canEdit?: boolean;
  onRename?: () => void;
  onSetPrivacy?: (privacy: PlaylistPrivacy) => void;
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [editAnchor, setEditAnchor] = useState<DOMRect | null>(null);
  const [visibilityAnchor, setVisibilityAnchor] = useState<DOMRect | null>(null);
  const [menuId] = useState(() => nextMenuId());
  const editable = canEdit && onRename && onSetPrivacy;

  useMenuPosition(menuRef, x, y);

  const cancelClose = () => {
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setEditAnchor(null);
      setVisibilityAnchor(null);
    }, 200);
  };

  const closeFlyouts = () => {
    cancelClose();
    setEditAnchor(null);
    setVisibilityAnchor(null);
  };

  const openEdit = (element: HTMLElement) => {
    cancelClose();
    setEditAnchor(element.getBoundingClientRect());
  };

  const openVisibility = (element: HTMLElement) => {
    cancelClose();
    setVisibilityAnchor(element.getBoundingClientRect());
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

        {editable && (
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={editAnchor != null}
            className={cn(itemClass, "border-t border-white/5", editAnchor && "bg-white/10")}
            onClick={(event) => {
              if (!editAnchor) openEdit(event.currentTarget);
            }}
            onPointerEnter={(event) => openEdit(event.currentTarget)}
          >
            <span className={`${iconClass} icon-[solar--pen-new-square-linear]`} />
            <span className="min-w-0 flex-1 truncate">Edit</span>
            <span className={`${chevronClass} icon-[solar--alt-arrow-right-linear]`} />
          </button>
        )}
      </div>

      {editable && editAnchor && (
        <MenuFlyout anchor={editAnchor} onPointerEnter={cancelClose} onPointerLeave={scheduleClose}>
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => choose(onRename)}
            onPointerEnter={() => setVisibilityAnchor(null)}
          >
            <span className={`${iconClass} icon-[solar--pen-linear]`} />
            <span className="min-w-0 flex-1 truncate">Rename</span>
          </button>
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={visibilityAnchor != null}
            className={cn(itemClass, visibilityAnchor && "bg-white/10")}
            onClick={(event) => {
              if (!visibilityAnchor) openVisibility(event.currentTarget);
            }}
            onPointerEnter={(event) => openVisibility(event.currentTarget)}
          >
            <span className={`${iconClass} icon-[solar--eye-linear]`} />
            <span className="min-w-0 flex-1 truncate">Visibility</span>
            <span className={`${chevronClass} icon-[solar--alt-arrow-right-linear]`} />
          </button>
        </MenuFlyout>
      )}

      {editable && visibilityAnchor && (
        <MenuFlyout
          anchor={visibilityAnchor}
          width={192}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
        >
          {PRIVACY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              className={itemClass}
              onClick={() => choose(() => onSetPrivacy?.(option.value))}
            >
              <span className={`${iconClass} ${option.iconClass}`} />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
            </button>
          ))}
        </MenuFlyout>
      )}
    </>,
    document.body,
  );
};
