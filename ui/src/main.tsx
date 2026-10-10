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
import { Player, PlayerProvider, QueuePanel } from "./features/player";

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
      <PlayerProvider>
        <PlaylistProvider>
          <div className="flex flex-col h-screen overflow-hidden">
            <div className="flex flex-1 overflow-hidden">
              <Sidebar />
              <div className="flex flex-col flex-1 overflow-hidden rounded-xl bg-primary m-1.5 ml-0">
                <Switch>
                  <Route path="/" component={Home} />
                  <Route path="/library" component={Library} />
                  <Route path="/settings" component={Settings} />
                  <Route path="/playlist/:id" component={Playlist} />
                  <Route path="/album/:id" component={Album} />
                  <Route path="/artist/:id" component={Artist} />
                </Switch>
              </div>
              <QueuePanel />
            </div>
            <Player />
          </div>
        </PlaylistProvider>
      </PlayerProvider>
    </Router>
  );
};

createRoot(document.getElementById("root")!).render(<App />);
