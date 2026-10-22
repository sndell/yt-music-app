import type { ReactNode } from "react";

/**
 * One Home shelf. A flat title row keeps the page reading as a list of rails;
 * tinting every header with its first cover turned the feed into coloured
 * bands and pulled attention off the art. Search and Library already separate
 * sections this way, so Home follows the same scale.
 */
export const HomeSection = ({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) => (
  <section className="group/snap min-w-0">
    <header className="flex items-center justify-between gap-3">
      <h2 className="min-w-0 truncate text-xl font-bold">{title}</h2>
      {actions}
    </header>
    {children}
  </section>
);
