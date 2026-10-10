import type { MouseEvent } from "react";
import { cn } from "@/util/cn";

const ease = "duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]";

export const mediaScrimClass = cn(
  "pointer-events-none absolute inset-0 grid place-items-center bg-black/50 opacity-0 transition-opacity",
  ease,
  "group-hover:opacity-100 group-focus-within:opacity-100",
);

export const RevealIcon = ({
  iconClassName,
  grow = false,
  interactive = false,
  onClick,
}: {
  iconClassName: string;
  /** Scales up again while the pointer is on this icon, or on an ancestor `group/play`. */
  grow?: boolean;
  /** Hit target while a `pointer-events-none` scrim is covering the artwork. */
  interactive?: boolean;
  onClick?: () => void;
}) => {
  const handleClick = onClick
    ? (event: MouseEvent<HTMLSpanElement>) => {
        event.stopPropagation();
        onClick();
      }
    : undefined;

  return (
    <span
      onClick={handleClick}
      className={cn(
        "inline-grid origin-center scale-75 transition-transform group-hover:scale-100 group-focus-within:scale-100",
        ease,
        grow && "group/play",
        interactive && "pointer-events-auto p-2",
        onClick && "cursor-pointer",
      )}
    >
      <span
        className={cn(
          iconClassName,
          "inline-block origin-center",
          grow && cn("transition-transform group-hover/play:scale-125 group-focus-within/play:scale-125", ease),
        )}
      />
    </span>
  );
};
