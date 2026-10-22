import type { ReactNode } from "react";
import { cn } from "@/util/cn";

/**
 * One titled group of settings: a small label, a hairline, then its rows. No
 * card fill, because the rows already sit on the page's own surface and the
 * extra box only competes with the controls.
 */
export const SettingsSection = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="space-y-2">
    <h2 className="text-xs font-medium tracking-wide text-primary-dark uppercase">{title}</h2>
    <div className="divide-y divide-white/5 border-t border-white/5">{children}</div>
  </section>
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
