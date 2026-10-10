import { useLocation } from "wouter";
import { cn } from "@/util/cn";
import { SidebarList } from "@/features/playlist";

export const Sidebar = () => {
  return (
    <div className="flex w-20 shrink-0 flex-col gap-1.5 overflow-hidden p-1 transition-[width] duration-200 lg:w-72 lg:p-1.5">
      <div className="p-1.5 rounded-xl bg-primary">
        {/* <div className="flex gap-2 justify-center items-center pt-1.5 pb-3">
          <span className="icon-[solar--music-note-linear]" />
          <div className="font-bold">YTMusic</div>
        </div> */}
        <div className="flex flex-col gap-1.5">
          <SidebarItem
            icon="icon-[solar--home-2-linear]"
            path="/"
            text="Home"
          />
          <SidebarItem
            icon="icon-[solar--library-linear]"
            path="/library"
            text="Library"
          />
          <SidebarItem
            icon="icon-[solar--settings-linear]"
            path="/settings"
            text="Settings"
          />
        </div>
      </div>
      <div className="overflow-hidden flex-1 rounded-xl bg-primary">
        <SidebarList />
      </div>
    </div>
  );
};

const SidebarItem = ({
  icon,
  path,
  text,
}: {
  icon: string;
  path: string;
  text: string;
}) => {
  const [location, navigate] = useLocation();
  const isActive = location === path;

  return (
    <button
      onClick={() => navigate(path)}
      title={text}
      aria-label={text}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-1.5 transition-colors max-lg:justify-center max-lg:px-2",
        isActive ? "text-primary-light bg-primary-light" : "text-primary-dark hover:text-primary hover:bg-primary-light"
      )}
    >
      <span className={cn("text-lg", icon)} />
      <span className="hidden lg:inline">{text}</span>
    </button>
  );
};
