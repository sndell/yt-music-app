import type { ReactNode } from "react";
import { cn } from "@/util/cn";

/**
 * Blocker dialog shell the app's modals share. Fades the cover and eases the
 * card in from a slight pop, the way the flyout menus do.
 */
export const Modal = ({
  pending = false,
  cardClassName,
  onPointerDownOutside,
  children,
}: {
  /** While a request runs, presses on the cover do nothing. */
  pending?: boolean;
  /** Card width or other layout tweaks, e.g. max-w-sm. */
  cardClassName?: string;
  onPointerDownOutside: () => void;
  children: ReactNode;
}) => {
  const coverPress = () => {
    if (pending) return;
    onPointerDownOutside();
  };

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center overflow-y-auto bg-black/60 p-4 transition-[opacity] duration-200 ease-out starting:opacity-0"
      onPointerDown={coverPress}
    >
      <div
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        className={cn(
          "w-full max-w-md rounded-2xl bg-primary p-4 shadow-[0_20px_60px_rgb(0_0_0/0.7)]",
          "transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] starting:scale-95 starting:opacity-0",
          cardClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
};
