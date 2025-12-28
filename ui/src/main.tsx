import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Route, Switch } from "wouter";
import { Home } from "./pages/Home";
import { Sidebar } from "./components/ui/Sidebar";
import { Library } from "./pages/Library";
import { Settings } from "./features/settings";
import "./styles/globals.css";
import { Playlist } from "./features/playlist";

const App = () => {
  return (
    <div className="flex flex-col min-h-screen">
      <div className="flex flex-1">
        <Sidebar />
        <div className="flex-1 rounded-xl bg-primary overflow-hidden m-1.5 ml-0 ">
          <Switch>
            <Route path="/" component={Home} />
            <Route path="/library" component={Library} />
            <Route path="/settings" component={Settings} />
            <Route path="/playlist/:id" component={Playlist} />
          </Switch>
        </div>
      </div>
    </div>
  );
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
