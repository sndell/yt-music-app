import { IconButton } from "@/components/ui/IconButton";

/**
 * The popout window's controls: pin, collapse, close. The window has no header
 * band — the playing surfaces render these beside their own controls, on the
 * right edge of the row they belong to.
 */
export const WindowButtons = ({
  pinned,
  collapsed,
  onTogglePinned,
  onToggleCollapsed,
  onClose,
}: {
  pinned: boolean;
  collapsed: boolean;
  onTogglePinned: () => void;
  onToggleCollapsed: () => void;
  onClose: () => void;
}) => (
  <>
    <IconButton
      iconClass={pinned ? "icon-[solar--pin-bold]" : "icon-[solar--pin-linear]"}
      label={pinned ? "Let other windows cover it" : "Keep above other windows"}
      size="sm"
      tone="ghost"
      iconScale="dense"
      onClick={onTogglePinned}
    />
    <IconButton
      iconClass={collapsed ? "icon-[solar--alt-arrow-up-bold]" : "icon-[solar--alt-arrow-down-bold]"}
      label={collapsed ? "Expand" : "Collapse"}
      size="sm"
      tone="ghost"
      iconScale="dense"
      onClick={onToggleCollapsed}
    />
    <IconButton
      iconClass="icon-[solar--close-linear]"
      label="Close the popout"
      size="sm"
      tone="ghost"
      iconScale="dense"
      onClick={onClose}
    />
  </>
);
