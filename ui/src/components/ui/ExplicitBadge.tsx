import { cn } from "@/util/cn";

export const ExplicitBadge = ({ className }: { className?: string }) => (
  <span
    className={cn(
      "grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] border border-current text-[9px] leading-none",
      className,
    )}
  >
    E
  </span>
);
