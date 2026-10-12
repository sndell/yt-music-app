import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/util/cn";

export type PlaybackExtraAction = {
  label: string;
  /** Full Iconify class, e.g. `icon-[solar--soundwave-linear]`. */
  iconClass: string;
  onClick: () => void;
};

export const PlaybackButtons = ({
  onPlay,
  onShuffle,
  extra,
  className,
}: {
  onPlay?: () => void;
  onShuffle?: () => void;
  /** Third outlined control, same treatment as Shuffle. Artist Radio uses this. */
  extra?: PlaybackExtraAction;
  /** Kept so existing call sites compile. Both values render the same circular controls. */
  variant?: "pill" | "icon";
  className?: string;
}) => {
  if (!onPlay && !onShuffle && !extra) return null;

  return (
    <div className={cn("flex shrink-0 items-center gap-2", className)}>
      {onPlay && (
        <IconButton
          iconClass="icon-[solar--play-bold]"
          label="Play"
          size="md"
          tone="solid"
          iconScale="transport"
          onClick={onPlay}
        />
      )}
      {onShuffle && (
        <IconButton
          iconClass="icon-[solar--shuffle-linear]"
          label="Shuffle"
          size="md"
          tone="outline"
          iconScale="transport"
          onClick={onShuffle}
        />
      )}
      {extra && (
        <IconButton
          iconClass={extra.iconClass}
          label={extra.label}
          size="md"
          tone="outline"
          iconScale="transport"
          onClick={extra.onClick}
        />
      )}
    </div>
  );
};
