import type { ReactNode } from "react";
import { cn } from "@/util/cn";

/**
 * One titled group of settings: a small label, a hairline, then its rows. No
 * card fill, because the rows already sit on the page's own surface and the
 * extra box only competes with the controls.
 */

export const SettingsSection = ({ title, badge, children }: { title: string; badge?: ReactNode; children: ReactNode }) => (
  <section className="space-y-2">
    <div className="flex items-center gap-2">
      <h2 className="text-xs font-medium tracking-wide text-primary-dark uppercase">{title}</h2>
      {badge}
    </div>
    <div className="divide-y divide-white/5 border-t border-white/5">{children}</div>
  </section>
);

export const SettingsAction = ({ children, onClick, disabled = false, primary = false }: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** Filled white, for the one action a section wants the eye on. */
  primary?: boolean;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={cn(
      "h-8 shrink-0 cursor-pointer rounded-full px-3.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
      primary ? "bg-white font-medium text-black hover:bg-white/85" : "border border-white/20 text-primary hover:bg-white/10",
    )}
  >
    {children}
  </button>
);

/**
 * A label, a short explanation, and the control that changes it. The control
 * stays centred against the whole text block, and `detail` takes a result line
 * under the row so a status does not shove the control out of line.
 */
export const SettingsRow = ({
  title,
  description,
  control,
  detail,
  detailTone = "quiet",
}: {
  title: string;
  description?: string;
  /** Right-hand control: a switch, a button, or a value. */
  control?: ReactNode;
  detail?: string | null;
  detailTone?: "quiet" | "error";
}) => (
  <div className="space-y-1.5 py-4">
    <div className="flex items-center justify-between gap-8">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {description && <p className="mt-1 max-w-[56ch] text-sm leading-snug text-primary-dark">{description}</p>}
      </div>
      {control && <div className="shrink-0">{control}</div>}
    </div>
    {detail && (
      <p
        className={cn(
          "max-w-[56ch] text-sm",
          detailTone === "error" ? "text-red-500" : "text-primary-dark",
        )}
      >
        {detail}
      </p>
    )}
  </div>
);
