import { Link, useLocation } from "wouter";
import { cn } from "../../util/cn";
import { SidebarList } from "../../features/playlist";

export const Sidebar = () => {
  return (
    <div className="flex flex-col gap-1.5 p-1.5 w-64">
      <div className="p-1.5 rounded-xl bg-primary">
        <div className="flex gap-2 justify-center items-center pt-1.5 pb-3">
          <span className="icon-[material-symbols--youtube-music]" />
          <div className="font-bold">YTMusic</div>
        </div>
        <div className="flex flex-col gap-1.5">
          <SidebarItem
            icon="icon-[mingcute--home-3-line]"
            iconHighlighted="icon-[mingcute--home-3-fill]"
            path="/"
            text="Home"
          />
          <SidebarItem
            icon="icon-[mingcute--book-5-line]"
            iconHighlighted="icon-[mingcute--book-5-fill]"
            path="/library"
            text="Library"
          />
          <SidebarItem
            icon="icon-[mingcute--settings-3-line]"
            iconHighlighted="icon-[mingcute--settings-3-fill]"
            path="/settings"
            text="Settings"
          />
        </div>
      </div>
      <div className="flex-1 rounded-xl bg-primary p-1.5">
        <SidebarList />
      </div>
    </div>
  );
};

const SidebarItem = ({
  icon,
  iconHighlighted,
  path,
  text,
}: {
  icon: string;
  iconHighlighted: string;
  path: string;
  text: string;
}) => {
  const [location] = useLocation();
  const isActive = location === path;

  return (
    <Link
      href={path}
      className={cn(
        "flex gap-3 items-center px-1.5 py-1.5 rounded-lg transition-colors cursor-pointer",
        isActive ? "text-primary-light bg-primary-light" : "text-primary-dark hover:text-primary hover:bg-primary-light"
      )}
    >
      <span className={cn("text-lg", isActive ? iconHighlighted : icon)} />
      {text}
    </Link>
  );
};
