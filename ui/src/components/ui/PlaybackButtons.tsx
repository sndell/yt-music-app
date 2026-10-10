import { cn } from "@/util/cn";

export type PlaybackExtraAction = {
  label: string;
  /** Full Iconify class, e.g. `icon-[solar--soundwave-linear]`. */
  iconClass: string;
  onClick: () => void;
};

const pillPlayClass =
  "flex h-12 shrink-0 cursor-pointer items-center gap-2 rounded-full bg-white px-5 text-sm text-black transition-colors hover:bg-white/85";
const pillOutlineClass =
  "flex h-12 shrink-0 cursor-pointer items-center gap-2 rounded-full border border-white/40 bg-transparent px-5 text-sm text-white transition-colors hover:bg-white/10";
const iconPlayClass =
  "grid size-10 shrink-0 cursor-pointer place-items-center rounded-full bg-white text-black transition-colors hover:bg-white/85";
const iconOutlineClass =
  "grid size-10 shrink-0 cursor-pointer place-items-center rounded-full border border-white/40 bg-transparent text-white transition-colors hover:bg-white/10";

export const PlaybackButtons = ({
  onPlay,
  onShuffle,
  extra,
  variant = "pill",
  className,
}: {
  onPlay?: () => void;
  onShuffle?: () => void;
  /** Third outlined control, same treatment as Shuffle. Artist Radio uses this. */
  extra?: PlaybackExtraAction;
  variant?: "pill" | "icon";
  className?: string;
}) => {
  if (!onPlay && !onShuffle && !extra) return null;

  const icon = variant === "icon";

  return (
    <div className={cn("flex shrink-0 items-center gap-2", className)}>
      {onPlay && (
        <button type="button" onClick={onPlay} aria-label={icon ? "Play" : undefined} className={icon ? iconPlayClass : pillPlayClass}>
          <span className={cn("icon-[solar--play-bold]", !icon && "text-lg")} />
          {!icon && "Play"}
        </button>
      )}
      {onShuffle && (
        <button
          type="button"
          onClick={onShuffle}
          aria-label={icon ? "Shuffle" : undefined}
          className={icon ? iconOutlineClass : pillOutlineClass}
        >
          <span className={cn("icon-[solar--shuffle-linear]", !icon && "text-lg")} />
          {!icon && "Shuffle"}
        </button>
      )}
      {extra && (
        <button
          type="button"
          onClick={extra.onClick}
          aria-label={icon ? extra.label : undefined}
          className={icon ? iconOutlineClass : pillOutlineClass}
        >
          <span className={cn(extra.iconClass, !icon && "text-lg")} />
          {!icon && extra.label}
        </button>
      )}
    </div>
  );
};
