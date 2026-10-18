import type { ReactNode } from "react";

/**
 * One Home shelf as a tinted chapter. The header takes its colours from the
 * shelf's first cover, so every category has its own light, and the title with
 * its rule does the structural separation. The rail below stays flat; a box
 * around every shelf read as a grid rather than a feed.
 */
export const HomeSection = ({
  title,
  art,
  actions,
  children,
}: {
  title: string;
  art?: string;
  actions?: ReactNode;
  children: ReactNode;
}) => (
  <section className="group/snap min-w-0">
    <header className="relative isolate -mx-4 overflow-hidden px-4 pt-5 pb-5 sm:-mx-6 sm:px-6">
      {art && (
        <img
          src={art}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 h-full w-full scale-110 object-cover opacity-25 blur-2xl"
        />
      )}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-linear-to-r from-primary/85 via-primary/55 to-transparent"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-5 bg-linear-to-b from-primary to-transparent"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-2/3 bg-linear-to-b from-transparent to-primary"
      />
      <div className="relative flex items-center gap-4">
        <h2 className="min-w-0 truncate text-2xl font-bold tracking-tight">{title}</h2>
        <span aria-hidden="true" className="h-px min-w-6 flex-1 bg-white/12" />
        {actions}
      </div>
    </header>
    {children}
  </section>
);
