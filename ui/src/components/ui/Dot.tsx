import { cn } from "@/util/cn";

/** A small filled dot used as a badge (new update, etc.). Fixed in px, so it does not scale with the icon font-size around it. */
export const Dot = ({ className }: { className?: string }) => (
  <span aria-hidden className={cn("h-2 w-2 rounded-full bg-accent", className)} />
);
