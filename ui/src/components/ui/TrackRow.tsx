import type { ReactNode } from "react";
import type { Thumbnail } from "@/lib/api";
import { cn } from "@/util/cn";
import { CoverFrame } from "@/components/ui/CoverFrame";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { RevealIcon, mediaScrimClass } from "@/components/ui/RevealIcon";

const DENSITY = {
  /** Library preview and the search page. */
  comfortable: "gap-3 px-2 py-2",
  /** Search sidebar flyout and quick picks. */
  compact: "gap-3 px-2 py-1.5",
  /** Queue rows, which sit inside a panel. */
  panel: "gap-2.5 p-1.5",
} as const;

/**
 * One compact track row, shared by the library preview, search results, the
 * queue, and quick picks. Collection pages use the grid row in
 * PlaylistTrackList, which carries links, selection, and like buttons.
 *
 * `rowClassName` and `rowStyle` are for the queue's cover-derived tint, which
 * is the one visual difference that does not fit a prop.
 */
export const TrackRow = ({
  title,
  subtitle,
  thumbnails,
  fallbackIcon,
  coverShape = "square",
  coverSize = "md",
  explicit = false,
  explicitOnSubtitle = false,
  trailing,
  playing = false,
  current = false,
  menuOpen = false,
  disabled = false,
  density = "comfortable",
  reveal = true,
  onActivate,
  onContextMenu,
  shouldActivate,
  rowClassName,
  rowStyle,
  coverClassName,
}: {
  title: string;
  subtitle?: string;
  thumbnails?: Thumbnail[] | null;
  fallbackIcon?: string;
  coverShape?: "square" | "round" | "video";
  coverSize?: "sm" | "md" | "lg";
  explicit?: boolean;
  /** Home puts the badge on the subtitle line; every other list puts it beside the title. */
  explicitOnSubtitle?: boolean;
  trailing?: ReactNode;
  playing?: boolean;
  current?: boolean;
  menuOpen?: boolean;
  disabled?: boolean;
  density?: keyof typeof DENSITY;
  /** False for rows that cannot play, such as an unavailable library track. */
  reveal?: boolean;
  onActivate: () => void;
  onContextMenu?: (x: number, y: number) => void;
  /** Returns true when the click belongs to a drag, not a press. */
  shouldActivate?: () => boolean;
  rowClassName?: string;
  rowStyle?: React.CSSProperties;
  coverClassName?: string;
}) => (
  <button
    type="button"
    onClick={() => {
      if (shouldActivate?.()) return;
      onActivate();
    }}
    onContextMenu={
      onContextMenu
        ? (event) => {
            event.preventDefault();
            onContextMenu(event.clientX, event.clientY);
          }
        : undefined
    }
    disabled={disabled}
    aria-label={`Play ${title}`}
    data-menu-open={menuOpen ? "true" : undefined}
    style={rowStyle}
    className={cn(
      "group flex w-full min-w-0 cursor-pointer items-center rounded-lg text-left transition-colors hover:bg-primary-light data-[menu-open=true]:bg-primary-light disabled:cursor-default",
      DENSITY[density],
      playing && "bg-primary-light",
      current && "text-primary",
      rowClassName,
    )}
  >
    <CoverFrame
      thumbnails={thumbnails}
      fallbackIcon={fallbackIcon}
      shape={coverShape}
      size={coverSize}
      className={coverClassName}
    >
      {reveal && (
        <span className={mediaScrimClass}>
          <RevealIcon iconClassName="icon-[solar--play-bold] text-lg" />
        </span>
      )}
    </CoverFrame>
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate text-sm font-medium">{title}</span>
        {explicit && !explicitOnSubtitle && <ExplicitBadge />}
      </span>
      {explicitOnSubtitle ? (
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-primary-dark">
          {explicit && <ExplicitBadge />}
          {subtitle && <span className="truncate">{subtitle}</span>}
        </span>
      ) : (
        subtitle && <span className="block truncate text-xs text-primary-dark">{subtitle}</span>
      )}
    </span>
    {trailing}
  </button>
);
