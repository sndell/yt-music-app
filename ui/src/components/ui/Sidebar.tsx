import { useState } from "react";
import { useLocation } from "wouter";
import { cn } from "@/util/cn";
import { SidebarList } from "@/features/playlist";
import { SidebarSearch } from "@/features/search";

export const Sidebar = () => {
  const [searchOpen, setSearchOpen] = useState(false);
  // The term outlives the field, so closing search and opening it again shows
  // what was last searched instead of an empty box.
  const [searchQuery, setSearchQuery] = useState("");

  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-1.5 overflow-hidden p-1 transition-[width] duration-200",
        searchOpen ? "w-72 p-1.5" : "w-20 lg:w-72 lg:p-1.5",
      )}
    >
      <div className="rounded-xl bg-primary p-1.5">
        <div className="flex flex-col gap-1.5">
          <SidebarItem icon="icon-[solar--home-2-linear]" path="/" text="Home" />
          <SidebarItem icon="icon-[solar--library-linear]" path="/library" text="Library" />
          <SidebarItem icon="icon-[solar--history-linear]" path="/history" text="History" />
          {searchOpen ? (
            <SidebarSearch
              query={searchQuery}
              onQueryChange={setSearchQuery}
              onClose={() => setSearchOpen(false)}
            />
          ) : (
            <SidebarItem
              icon="icon-[solar--magnifer-linear]"
              path="/search"
              text="Search"
              onClick={() => setSearchOpen(true)}
            />
          )}
          <SidebarItem icon="icon-[solar--settings-linear]" path="/settings" text="Settings" />
        </div>
      </div>
      <div className="flex-1 overflow-hidden rounded-xl bg-primary">
        <SidebarList />
      </div>
    </div>
  );
};

const SidebarItem = ({
  icon,
  path,
  text,
  onClick,
}: {
  icon: string;
  path: string;
  text: string;
  /** Overrides navigation, for items that open something in place (Search). */
  onClick?: () => void;
}) => {
  const [location, navigate] = useLocation();
  const isActive = location === path || (path === "/search" && location.startsWith("/search"));

  return (
    <button
      onClick={() => (onClick ? onClick() : navigate(path))}
      title={text}
      aria-label={text}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-1.5 transition-colors max-lg:justify-center max-lg:px-2",
        isActive ? "text-primary-light bg-primary-light" : "text-primary-dark hover:text-primary hover:bg-primary-light",
      )}
    >
      <span className={cn("text-lg", icon)} />
      <span className="hidden lg:inline">{text}</span>
    </button>
  );
};
