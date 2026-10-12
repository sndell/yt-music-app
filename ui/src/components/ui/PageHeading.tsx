import type { ReactNode } from "react";

export const PageHeading = ({ children }: { children: ReactNode }) => (
  <h1 className="pb-3 text-xl font-bold">{children}</h1>
);
