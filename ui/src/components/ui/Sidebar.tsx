import { useLocation } from "wouter";
import { cn } from "@/util/cn";
import { SidebarList } from "@/features/playlist";
import { SidebarSearch } from "@/features/search";
import { useHorizontalNav } from "@/lib/horizontalNav";
import { closeSideSearch, openSideSearch, setSideSearchQuery, useSideSearch } from "@/lib/sideSearch";

export const Sidebar = () => {
  const search = useSideSearch();
  const horizontalNav = useHorizontalNav();

  return (
    /* Marked so the search panel can measure this box and sit beside it; the
       panel is one fixed position in both nav modes. */
    <div
      data-sidebar
      className={cn(
        "flex shrink-0 flex-col gap-1.5 overflow-hidden p-1 transition-[width] duration-200",
        "w-20 lg:w-72",
        horizontalNav ? "p-1.5" : "p-1 lg:p-1.5",
      )}
    >
      {/* Both modes use the same floating panel, so this mount only hosts its
          portal; the placement was fixed at open time from the Search icon. */}
      {search.open && (
        <SidebarSearch query={search.query} onQueryChange={setSideSearchQuery} onClose={closeSideSearch} />
      )}
      <div className="rounded-xl bg-primary p-1.5">
        {/* Horizontal nav: one icon-only row at lg. It frees the line height the
            labeled stack used, so more playlist rows fit below. The strip only
            fits wide windows; below lg five icons do not fit the narrow column,
            so it stays the vertical stack. Buttons share the row evenly, so the
            gaps between them stay `gap-1.5` instead of spreading open. */}
        <div className={cn("flex flex-col gap-1.5", horizontalNav && "lg:flex-row lg:gap-1.5")}>
          <SidebarItem icon="icon-[solar--home-2-linear]" path="/" text="Home" iconOnly={horizontalNav} />
          <SidebarItem icon="icon-[solar--compass-linear]" path="/explore" text="Explore" iconOnly={horizontalNav} />
          <SidebarItem icon="icon-[solar--library-linear]" path="/library" text="Library" iconOnly={horizontalNav} />
          <NavSearch horizontalNav={horizontalNav} active={search.open} />
          <SidebarItem icon="icon-[solar--settings-linear]" path="/settings" text="Settings" iconOnly={horizontalNav} />
        </div>
      </div>
      <div className="flex-1 overflow-hidden rounded-xl bg-primary">
        <SidebarList />
      </div>
    </div>
  );
};

/** Search never renders a field in the sidebar: every mode opens the floating
    panel. Only its placement differs, fixed at open time from this icon. */
const NavSearch = ({ horizontalNav, active }: { horizontalNav: boolean; active: boolean }) => {
  const [location] = useLocation();
  const isActive = active || location.startsWith("/search");

  return (
    <button
      type="button"
      title="Search"
      aria-label="Search"
      onClick={() => (active ? closeSideSearch() : openSideSearch())}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-1.5 transition-colors max-lg:justify-center max-lg:px-2",
        horizontalNav && "lg:flex-1 lg:justify-center",
        isActive ? "text-primary-light bg-primary-light" : "text-primary-dark hover:text-primary hover:bg-primary-light",
      )}
    >
      <span className="icon-[solar--magnifer-linear] text-lg" />
      {!horizontalNav && <span className="hidden lg:inline">Search</span>}
    </button>
  );
};

const SidebarItem = ({
  icon,
  path,
  text,
  iconOnly = false,
  onClick,
}: {
  icon: string;
  path: string;
  text: string;
  /** Drops the label, for the experimental horizontal strip where the row is the icon. */
  iconOnly?: boolean;
  /** Overrides navigation, for items that open something in place. */
  onClick?: () => void;
}) => {
  const [location, navigate] = useLocation();
  const isActive = location === path;

  return (
    <button
      onClick={() => (onClick ? onClick() : navigate(path))}
      title={text}
      aria-label={text}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-1.5 transition-colors max-lg:justify-center max-lg:px-2",
        iconOnly && "lg:flex-1 lg:justify-center",
        isActive ? "text-primary-light bg-primary-light" : "text-primary-dark hover:text-primary hover:bg-primary-light",
      )}
    >
      <span className={cn("text-lg", icon)} />
      {!iconOnly && <span className="hidden lg:inline">{text}</span>}
    </button>
  );
};
