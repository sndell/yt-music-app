import { createRoot } from "react-dom/client";
import { Route, Switch } from "wouter";
import { Home } from "./pages/Home";
import { Sidebar } from "./components/ui/Sidebar";
import { Library } from "./pages/Library";
import { Settings } from "./features/settings";
import "./styles/globals.css";
import { Playlist } from "./features/playlist";
import { Player, PlayerProvider } from "./features/player";

const App = () => {
  return (
    <PlayerProvider>
      <div className="flex flex-col h-screen overflow-hidden">
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <div className="flex flex-col flex-1 overflow-hidden rounded-xl bg-primary m-1.5 ml-0">
            <Switch>
              <Route path="/" component={Home} />
              <Route path="/library" component={Library} />
              <Route path="/settings" component={Settings} />
              <Route path="/playlist/:id" component={Playlist} />
            </Switch>
          </div>
        </div>
        <Player />
      </div>
    </PlayerProvider>
  );
};

createRoot(document.getElementById("root")!).render(<App />);
