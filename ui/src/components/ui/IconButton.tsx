import { cn } from "@/util/cn";
import type { MouseEvent } from "react";

export type IconButtonSize = "sm" | "md";
export type IconButtonTone = "ghost" | "active" | "solid" | "outline";
export type IconButtonScale = "transport" | "secondary" | "dense";

const sizeClass: Record<IconButtonSize, string> = {
  sm: "size-8",
  md: "size-10",
};

const toneClass: Record<IconButtonTone, string> = {
  ghost: "text-primary-dark hover:bg-primary-light hover:text-primary",
  active: "bg-control-active text-primary hover:bg-control-active-hover",
  solid: "bg-white text-black hover:bg-white/85",
  outline: "border border-white/40 bg-transparent text-white hover:bg-white/10",
};

const scaleClass: Record<IconButtonScale, string> = {
  transport: "text-2xl",
  secondary: "text-xl",
  dense: "text-lg",
};

export const IconButton = ({
  iconClass,
  label,
  size,
  tone,
  iconScale,
  onClick,
  disabled,
  className,
  type = "button",
}: {
  /** Full Iconify class, e.g. `icon-[solar--play-bold]`. */
  iconClass: string;
  /** Accessible name (`aria-label`). */
  label: string;
  size: IconButtonSize;
  tone: IconButtonTone;
  /**
   * Transport (`text-2xl`) is the large play button. Secondary (`text-xl`) is
   * the md default (like / volume). Dense (`text-lg`) is the sm default, used by
   * the smaller controls beside a collection's play button.
   */
  iconScale?: IconButtonScale;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit" | "reset";
}) => {
  const scale = iconScale ?? (size === "sm" ? "dense" : "secondary");

  return (
    <button
      type={type}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "grid place-items-center rounded-full cursor-pointer shrink-0 transition-colors duration-200 disabled:pointer-events-none disabled:opacity-40",
        sizeClass[size],
        toneClass[tone],
        scaleClass[scale],
        className,
      )}
    >
      <span className={iconClass} />
    </button>
  );
};
