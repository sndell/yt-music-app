import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Route, Router, Switch } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { Home } from "./pages/Home";
import { Sidebar } from "./components/ui/Sidebar";
import { Library } from "./pages/Library";
import { Settings } from "./features/settings";
import "./styles/globals.css";
import { Playlist, PlaylistProvider } from "./features/playlist";
import { Album } from "./features/album";
import { Artist } from "./features/artist";
import { Search } from "./features/search";
import { Player, PlayerProvider, QueuePanel, VideoOverlay } from "./features/player";
import { ToastProvider } from "./components/ui/Toast";
import { installRendererLog } from "./dev/rendererLog";

const App = () => {
  useEffect(() => {
    const blockBrowserMenu = (event: MouseEvent) => {
      event.preventDefault();
    };
    document.addEventListener("contextmenu", blockBrowserMenu, true);
    return () => document.removeEventListener("contextmenu", blockBrowserMenu, true);
  }, []);

  return (
    <Router hook={useHashLocation}>
      <ToastProvider>
        <PlayerProvider>
          <PlaylistProvider>
            <div className="flex flex-col h-screen overflow-hidden">
              <div className="flex flex-1 overflow-hidden">
                <div className="relative flex flex-1 overflow-hidden">
                  <Sidebar />
                  <div className="flex flex-col flex-1 overflow-hidden rounded-xl bg-primary m-1.5 ml-0">
                    <Switch>
                      <Route path="/" component={Home} />
                      <Route path="/library" component={Library} />
                      <Route path="/settings" component={Settings} />
                      <Route path="/playlist/:id" component={Playlist} />
                      <Route path="/album/:id" component={Album} />
                      <Route path="/artist/:id" component={Artist} />
                      <Route path="/search" component={Search} />
                    </Switch>
                  </div>
                  <VideoOverlay />
                </div>
                <QueuePanel />
              </div>
              <Player />
            </div>
          </PlaylistProvider>
        </PlayerProvider>
      </ToastProvider>
    </Router>
  );
};

// Reuse the root if this module runs again (HMR): calling createRoot twice on
// the same container is an error, re-rendering the existing root is not.
type RootContainer = HTMLElement & { __ytmusicRoot?: ReturnType<typeof createRoot> };
const container = document.getElementById("root") as RootContainer;
const root = container.__ytmusicRoot ?? createRoot(container);
container.__ytmusicRoot = root;

if (import.meta.env.DEV) installRendererLog();

root.render(<App />);
