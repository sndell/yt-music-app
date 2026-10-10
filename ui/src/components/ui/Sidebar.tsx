import { useLocation } from "wouter";
import { cn } from "@/util/cn";
import { SidebarList } from "@/features/playlist";

export const Sidebar = () => {
  return (
    <div className="flex flex-col gap-1.5 p-1.5 w-72 overflow-hidden ">
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
      className={cn(
        "flex gap-3 items-center px-3 py-1.5 rounded-lg transition-colors cursor-pointer",
        isActive ? "text-primary-light bg-primary-light" : "text-primary-dark hover:text-primary hover:bg-primary-light"
      )}
    >
      <span className={cn("text-lg", icon)} />
      {text}
    </button>
  );
};
